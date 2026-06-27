import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, coreApi } from "./http.js";
import {
  buyerAuthStatusOutput, buyerRunOutput, getBuyerCheckout, getBuyerPaymentIntent, isBuyerDeliveryComplete, noRecoverableContext,
  recoverableBuyerContextForStatus, recoverableIntentCheckGuidance
} from "./buyer.js";
import { renderHumanAction, shouldReturnAfterAgentTextQR, writeWaitHeartbeat } from "./render-human.js";
import { accountOverviewStatus, nextActionForAuthStatus, outputAccountStatus, refreshBuyerSessionForStatus } from "./account-status.js";
import {
  CREDENTIALS_PATH, CONFIG_DIR, RUNS_DIR, VERSION, apiBase, apiTimeoutMs, appendURLQuery, booleanFlag, cliCommand, commandExists,
  cryptoRandom, csvValues, currentExecutable, deleteGrantCredential, deleteSessionCredential, detectNativeCredentialStore,
  escapeTomlString, fileMode, intFlag, listRuns, maskSecret, mergeRun, output, parseFlags, positional, prepareSetupRun,
  queryString, quoteShell, readConfig, readCredentials, readGrantCredential, readJSON, readRun, readSessionToken, readState,
  readText, replaceManagedBlock, safeErrorMessage, sanitizeAuthResponse, shellQuote, sleep, storeGrantCredential,
  updateCurrentRun, updateRun, withStateLock, writeConfig, writeCredentials, writeJSONWithBackup, writeRun,
  writeSessionCredentials, writeState, writeTextWithBackup
} from "./env.js";

async function authRegister(flags) {
  const response = await completeDeviceAuth(flags);
  output(response);
}

async function setup(flags) {
  return await withStateLock(async () => {
    const target = flags.target || flags.runtime || "generic";
    const purchase = normalizePurchaseFlags(flags, true);
    const plan = purchase.plan || null;
    const credits = purchase.credits || null;
    const method = flags.method || "alipay";
    validateLivePaymentFlags(method, flags);
    const shouldInstallRuntime = Boolean(flags.install_runtime || flags.install_config || flags.write_runtime_config) && !flags.no_runtime_install && !flags.no_install;
    if (shouldInstallRuntime && target === "generic") {
      throw new Error("--install-runtime requires --target codex, --target claude-code, or --target openclaw");
    }

    let run = prepareSetupRun(flags, { target, plan, credits, method, install_runtime: shouldInstallRuntime });
    const setupFlags = { ...flags, runtime: target, run_id: run.run_id };
    if (shouldReturnAfterAgentTextQR(setupFlags)) {
      setupFlags.no_wait_auth = true;
      setupFlags.no_wait_payment = true;
    }
    run = updateRun(run, { phase: "checking_auth", status: "running", api_base: apiBase(setupFlags) });

    const auth = await ensureAuthenticated(setupFlags);
    if (!auth.authenticated) {
      run = mergeRun(run, {
        phase: "waiting_human_auth",
        status: "waiting_human_auth",
        auth: {
          auth_id: auth.auth_id,
          status: "pending",
          expires_at: auth.expires_at
        },
        human_action: auth.human_action || null,
        safe_summary: "Waiting for Alipay authentication scan."
      });
      writeRun(run);
      output(agentRunResponse(run, {
        status: "waiting_human_auth",
        action: "scan_alipay_auth",
        auth_id: auth.auth_id,
        user_code: auth.user_code,
        verification_uri: auth.verification_uri,
        verification_uri_complete: auth.verification_uri_complete,
        alipay_authorization_url: auth.alipay_authorization_url,
        expires_at: auth.expires_at,
        interval: auth.interval,
        human_action: auth.human_action,
        next_action: {
          type: "show_qr_and_wait",
          command: resumeCommand(run, setupFlags, { no_wait_payment: Boolean(setupFlags.no_wait_payment) }),
          retry_after_ms: Number(auth.interval || 2) * 1000
        }
      }));
      return;
    }

    run = mergeRun(run, {
      phase: "authenticated",
      status: "running",
      account: {
        authenticated: true,
        account_id: auth.account_id,
        device_id: auth.device_id,
        newapi_user_id: auth.newapi_user_id || null,
        session_reused: Boolean(auth.session_reused)
      },
      auth: {
        ...(run.auth || {}),
        status: "consumed"
      },
      human_action: null,
      safe_summary: "Agent device authenticated."
    });
    writeRun(run);

    let checkout = run.checkout?.checkout_id
      ? await api(`/api/itp/checkout/${encodeURIComponent(run.checkout.checkout_id)}`, { method: "GET" }, setupFlags)
      : null;
    if (!checkout || isTerminalCheckoutFailure(checkout.status)) {
      checkout = await createCheckoutResult({
        ...setupFlags,
        plan,
        credits,
        method,
        idempotency_key: flags.idempotency_key || run.idempotency_key
      });
    }

    run = mergeRun(run, {
      phase: checkout.grant_id ? "grant_ready" : "waiting_human_payment",
      status: checkout.grant_id ? "grant_ready" : "waiting_human_payment",
      plan_id: checkout.plan_id || plan,
      credits: checkout.credits || credits,
      purchase_kind: checkout.purchase?.kind || purchase.kind,
      checkout: {
        checkout_id: checkout.checkout_id,
        order_id: checkout.order_id,
        status: checkout.status,
        expires_at: checkout.expires_at,
        purchase: checkout.purchase || null
      },
      payment: {
        provider: method,
        status: checkout.status
      },
      grant: {
        ...(run.grant || {}),
        grant_id: checkout.grant_id || run.grant?.grant_id || null
      },
      human_action: checkout.human_action || null,
      safe_summary: checkout.grant_id ? "Payment verified and grant is ready." : "Waiting for Alipay or WeChat Pay payment scan."
    });
    writeRun(run);

    if (checkout.human_action) {
      await renderHumanAction(checkout.human_action, setupFlags);
    } else if (checkout.payment?.cashier_url) {
      process.stderr.write(`Open Alipay or WeChat Pay payment URL: ${checkout.payment.cashier_url}\n`);
    }

    if (!checkout.grant_id && (setupFlags.no_wait_payment || setupFlags.no_wait)) {
      output(agentRunResponse(run, {
        status: "waiting_human_payment",
        action: "scan_alipay_payment",
        account_id: auth.account_id,
        device_id: auth.device_id,
        checkout_id: checkout.checkout_id,
        order_id: checkout.order_id,
        plan_id: checkout.plan_id || plan,
        credits: checkout.credits || credits,
        purchase: checkout.purchase || null,
        expires_at: checkout.expires_at,
        payment: checkout.payment,
        human_action: checkout.human_action,
        next_action: checkout.next_action || {
          type: "show_qr_and_wait",
          command: resumeCommand(run, setupFlags),
          retry_after_ms: 2000
        }
      }));
      return;
    }

    const payment = checkout.grant_id
      ? { status: checkout.status, checkout_id: checkout.checkout_id, order_id: checkout.order_id, grant_id: checkout.grant_id }
      : await paymentWaitResult(checkout.checkout_id, setupFlags);
    run = mergeRun(readRun(run.run_id) || run, {
      phase: "grant_ready",
      checkout: {
        ...(run.checkout || {}),
        checkout_id: payment.checkout_id,
        order_id: payment.order_id,
        status: payment.status
      },
      payment: {
        provider: method,
        status: payment.status
      },
      grant: {
        grant_id: payment.grant_id,
        installed: false
      },
      human_action: null,
      safe_summary: "Payment verified and grant is ready."
    });
    writeRun(run);

    const grant = await grantsInstallResult(payment.grant_id, { ...setupFlags, target });
    const runtimeInstall = shouldInstallRuntime
      ? await installRuntimeResult(target, {
        ...setupFlags,
        grant: payment.grant_id,
        no_test: flags.test ? false : true
      })
      : {
        status: "skipped",
        reason: "runtime_config_install_is_opt_in",
        command: target === "generic"
          ? `${cliCommand("install")} <target> --grant ${shellQuote(payment.grant_id)} --json`
          : cliCommand("install", target, "--grant", payment.grant_id, "--json")
      };
    const tokenCommand = cliCommand("token", "issue", "--grant", payment.grant_id, "--stdout");
    run = mergeRun(readRun(run.run_id) || run, {
      phase: shouldInstallRuntime ? "done" : "grant_ready",
      status: shouldInstallRuntime ? "installed" : "grant_ready",
      grant: {
        grant_id: payment.grant_id,
        installed: true,
        credential_store: grant.credential?.credential_store || null
      },
      result: {
        base_url: grant.base_url,
        openai_base_url: grant.openai_base_url,
        anthropic_base_url: grant.anthropic_base_url,
        gemini_base_url: grant.gemini_base_url
      },
      safe_summary: shouldInstallRuntime ? "Runtime configured." : "Grant credential stored."
    });
    writeRun(run);

    output(agentRunResponse(run, {
      status: shouldInstallRuntime ? "installed" : "grant_ready",
      account_id: auth.account_id,
      device_id: auth.device_id,
      checkout_id: checkout.checkout_id,
      order_id: checkout.order_id,
      plan_id: checkout.plan_id || plan,
      credits: checkout.credits || credits,
      purchase: checkout.purchase || null,
      grant_id: payment.grant_id,
      target,
      base_url: grant.base_url,
      openai_base_url: grant.openai_base_url,
      anthropic_base_url: grant.anthropic_base_url,
      gemini_base_url: grant.gemini_base_url,
      credential: {
        stored: true,
        credential_store: grant.credential?.credential_store,
        warning: grant.credential?.warning,
        token_command: tokenCommand,
        stdout_required_for_raw_token: true
      },
      auth,
      checkout,
      payment,
      grant_install: grant,
      runtime_install: runtimeInstall,
      next_action: shouldInstallRuntime
        ? null
        : {
          type: "configure_agent_optional",
          token_command: tokenCommand,
          runtime_install_command: runtimeInstall.command
        }
    }));
  });
}

async function agentStatus(flags) {
  const runId = flags.run_id || readState().current_run_id;
  const run = readRun(runId);
  if (!run) {
    outputAccountStatus(await accountOverviewStatus(flags), flags);
    return;
  }
  const refreshed = flags.refresh ? await refreshRun(run, flags) : run;
  writeRun(refreshed);
  output(agentRunResponse(refreshed, {
    recoverable_context: recoverableRuntimeRunContext(refreshed)
  }));
}

async function resume(flags) {
  const runId = flags.run_id || readState().current_run_id;
  const run = readRun(runId);
  if (!run) throw new Error("no active run found");
  if (["done", "installed"].includes(run.status) || run.phase === "done") {
    output(agentRunResponse(run));
    return;
  }
  await setup({
    ...flags,
    run_id: run.run_id,
    resume: true,
    plan: run.plan_id || flags.plan,
    credits: run.plan_id ? flags.credits : run.credits || flags.credits,
    method: run.payment_method || flags.method,
    target: run.target || flags.target,
    install_runtime: run.install_runtime || flags.install_runtime
  });
}

async function runs(command, flags) {
  if (command === "current") {
    const run = readRun(flags.run_id || readState().current_run_id);
    output(run ? agentRunResponse(run) : { schema_version: "itp.agent.v1", status: "none", runs: [] });
    return;
  }
  if (command === "list") {
    output({ runs: listRuns().map(agentRunResponse) });
    return;
  }
  if (command === "show") {
    const run = readRun(flags.run_id || flags.id);
    if (!run) throw new Error("run not found");
    output(agentRunResponse(run));
    return;
  }
  if (command === "forget") {
    const runId = flags.run_id || flags.id;
    if (!runId || runId === "forget") throw new Error("run_id is required");
    const file = runPath(runId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const state = readState();
    if (state.current_run_id === runId) {
      delete state.current_run_id;
      writeState(state);
    }
    output({ status: "forgotten", run_id: runId });
    return;
  }
  throw new Error(`unknown runs command: ${command || ""}`);
}

async function startDeviceAuth(flags) {
  const runtime = flags.runtime || "unknown";
  return await api("/api/itp/auth/device/start", {
    method: "POST",
    body: {
      device: {
        display_name: os.hostname(),
        runtime,
        os: os.platform(),
        arch: os.arch(),
        itp_version: VERSION
      }
    }
  }, flags);
}

async function completeDeviceAuth(flags) {
  const start = await startDeviceAuth(flags);
  if (flags.no_wait) {
    writeState({ ...readState(), last_auth_id: start.auth_id });
    updateCurrentRun({
      phase: "waiting_human_auth",
      auth: { auth_id: start.auth_id, status: "pending", expires_at: start.expires_at },
      human_action: start.human_action || null,
      safe_summary: "Waiting for Alipay authentication scan."
    }, flags);
    await renderHumanAction(start.human_action, flags);
    return start;
  }
  await maybeMockApproveDeviceAuth(start.auth_id, flags);
  const response = await waitDeviceAuth(start.auth_id, flags, start);
  if (!response.auth) {
    throw new Error(`device auth ended without session: ${response.status || "unknown"}`);
  }
  writeSessionCredentials(response.auth);
  writeConfig({
    api_base: apiBase(flags),
    account_id: response.auth.account_id,
    device_id: response.auth.device_id,
    web_console_url: response.auth.web_console_url
  });
  writeState({ ...readState(), last_auth_id: start.auth_id });
  return { ...sanitizeAuthResponse(response.auth), auth_id: start.auth_id, status: response.status };
}

async function ensureAuthenticated(flags) {
  const config = readConfig();
  const credentials = readCredentials();
  if (readSessionToken(credentials)) {
    try {
      const status = await api("/api/itp/auth/status", { method: "GET" }, flags);
      if (status.authenticated !== false) {
        return {
          authenticated: true,
          account_id: status.account_id || config.account_id || null,
          device_id: status.device_id || config.device_id || null,
          newapi_user_id: status.newapi_user_id || null,
          session_reused: true
        };
      }
    } catch {
      deleteSessionCredential(credentials);
      writeCredentials(credentials);
    }
  }
  const resumableRun = readRun(flags.run_id || readState().current_run_id);
  if ((flags.resume || flags.auth_id) && resumableRun?.auth?.auth_id && !resumableRun.account?.authenticated && !resumableRun.checkout?.checkout_id && !flags.no_wait && !flags.no_wait_auth) {
    await renderHumanAction(resumableRun.human_action, flags);
    await maybeMockApproveDeviceAuth(resumableRun.auth.auth_id, flags);
    const response = await waitDeviceAuth(resumableRun.auth.auth_id, flags);
    if (!response.auth) {
      return {
        authenticated: false,
        status: response.status || "waiting_human_auth",
        auth_id: resumableRun.auth.auth_id,
        expires_at: resumableRun.auth.expires_at,
        human_action: resumableRun.human_action
      };
    }
    writeSessionCredentials(response.auth);
    writeConfig({
      api_base: apiBase(flags),
      account_id: response.auth.account_id,
      device_id: response.auth.device_id,
      web_console_url: response.auth.web_console_url
    });
    writeState({ ...readState(), last_auth_id: resumableRun.auth.auth_id });
    return { ...sanitizeAuthResponse(response.auth), auth_id: resumableRun.auth.auth_id, authenticated: true, session_reused: false };
  }
  if (flags.no_wait || flags.no_wait_auth) {
    const start = await startDeviceAuth(flags);
    writeState({ ...readState(), last_auth_id: start.auth_id });
    updateCurrentRun({
      phase: "waiting_human_auth",
      auth: { auth_id: start.auth_id, status: "pending", expires_at: start.expires_at },
      human_action: start.human_action || null,
      safe_summary: "Waiting for Alipay authentication scan."
    }, flags);
    await renderHumanAction(start.human_action, flags);
    return {
      authenticated: false,
      status: "waiting_human_auth",
      action: "scan_alipay_auth",
      auth_id: start.auth_id,
      user_code: start.user_code,
      verification_uri: start.verification_uri,
      verification_uri_complete: start.verification_uri_complete,
      alipay_authorization_url: start.alipay_authorization_url,
      expires_at: start.expires_at,
      interval: start.interval,
      human_action: start.human_action
    };
  }
  const auth = await completeDeviceAuth(flags);
  return { ...auth, authenticated: true, session_reused: false };
}

async function maybeMockApproveDeviceAuth(authId, flags) {
  if (!(flags.mock_approve || process.env.ITPAY_MOCK_APPROVE === "true" || process.env.ITPAY_MOCK_APPROVE === "1")) {
    return;
  }
  if (!fakeTestingAllowed(flags)) {
    throw new Error("mock approval is developer-only and disabled for agent runs; use real Alipay sandbox authentication");
  }
  const alipayUserId = flags.alipay_user_id || process.env.ITPAY_MOCK_ALIPAY_USER_ID || `2088${crypto.randomInt(100000000000, 999999999999)}`;
  await api(`/api/itp/auth/device/${encodeURIComponent(authId)}/mock-approve`, {
    method: "POST",
    body: { alipay_user_id: alipayUserId }
  }, flags);
}

async function authDevice(command, flags) {
  if (command === "start") {
    const response = await startDeviceAuth(flags);
    writeState({ ...readState(), last_auth_id: response.auth_id });
    await renderHumanAction(response.human_action, flags);
    output(response);
    return;
  }
  if (command === "poll") {
    const authId = flags.auth_id || flags.device_auth_id || readState().last_auth_id;
    if (!authId) throw new Error("auth_id is required");
    const response = await waitDeviceAuth(authId, flags);
    if (response.auth) {
      writeSessionCredentials(response.auth);
      writeConfig({
        api_base: apiBase(flags),
        account_id: response.auth.account_id,
        device_id: response.auth.device_id,
        web_console_url: response.auth.web_console_url
      });
    }
    output(response.auth ? { ...sanitizeAuthResponse(response.auth), auth_id: authId, status: response.status } : response);
    return;
  }
  throw new Error(`unknown auth device command: ${command || ""}`);
}

async function waitDeviceAuth(authId, flags, start = null) {
  const started = Date.now();
  const timeoutMs = Number(flags.timeout || 600) * 1000;
  let intervalMs = 2000;
  let lastHeartbeatAt = 0;
  let lastStatus = "authorization_pending";
  const action = start?.human_action || null;
  if (start) {
    updateCurrentRun({
      phase: "waiting_human_auth",
      auth: { auth_id: start.auth_id, status: "pending", expires_at: start.expires_at },
      human_action: start.human_action || null,
      safe_summary: "Waiting for Alipay authentication scan."
    }, flags);
    await renderHumanAction(start.human_action, flags);
    if (!start.human_action) process.stderr.write(`Open Alipay auth URL: ${start.verification_uri_complete || start.alipay_authorization_url}\n`);
    if (start.user_code) process.stderr.write(`Alipay auth code: ${start.user_code}\n`);
  }
  while (Date.now() - started < timeoutMs) {
    const response = await api(`/api/itp/auth/device/${encodeURIComponent(authId)}/poll`, { method: "POST" }, flags);
    lastStatus = response.status || lastStatus;
    if (response.auth?.session_token) {
      return response;
    }
    if (response.status === "authorization_pending") {
      intervalMs = Number(response.interval || 2) * 1000;
      lastHeartbeatAt = writeWaitHeartbeat({
        kind: "Alipay authentication",
        idName: "auth_id",
        idValue: authId,
        status: response.status,
        action,
        lastHeartbeatAt,
        flags,
        command: cliCommand("auth", "device", "poll", authId, "--timeout", String(Math.ceil((timeoutMs - (Date.now() - started)) / 1000)), "--json")
      });
      await sleep(intervalMs);
      continue;
    }
    if (response.status === "approved") {
      return response;
    }
    if (response.status === "expired" || response.status === "consumed" || response.error) {
      throw new Error(response.error || `device auth ended with status: ${response.status}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`device auth timed out at status ${lastStatus}; run \`itp auth device poll ${authId} --timeout 600\``);
}

async function authLogin(flags) {
  const runtime = flags.runtime || "unknown";
  if (flags.password && !flags.password_stdin) {
    throw new Error("use --password-stdin to avoid leaking passwords into shell history");
  }
  const password = flags.password_stdin
    ? fs.readFileSync(0, "utf8").trim()
    : undefined;
  if (flags.password_stdin && !password) {
    throw new Error("password is required on stdin");
  }
  const response = await api("/api/itp/auth/login", {
    method: "POST",
    body: {
      username: flags.username || undefined,
      password,
      access_token: flags.access_token || undefined,
      device: {
        display_name: os.hostname(),
        runtime,
        os: os.platform(),
        arch: os.arch(),
        itp_version: VERSION
      }
    }
  }, flags);
  writeSessionCredentials(response);
  writeConfig({
    api_base: apiBase(flags),
    account_id: response.account_id,
    device_id: response.device_id,
    web_console_url: response.web_console_url
  });
  output(sanitizeAuthResponse(response));
}

async function authStatus(flags) {
  const config = readConfig();
  const credentials = readCredentials();
  if (!readSessionToken(credentials)) {
    output({ authenticated: false, account_id: config.account_id || null });
    return;
  }
  try {
    const status = await api("/api/itp/auth/status", { method: "GET" }, flags);
    output(status);
  } catch (error) {
    output({
      authenticated: false,
      account_id: config.account_id || null,
      error: error.message
    });
  }
}

async function accountShow(flags) {
  output(await api("/api/itp/account", { method: "GET" }, flags));
}

async function accountLoginLink(flags) {
  const config = readConfig();
  const accountID = flags.account || flags.account_id || flags.buyer_account || flags.buyer_account_id || config.account_id;
  if (!accountID) {
    throw new Error("buyer account id is required; complete a buyer purchase first or pass --account-id");
  }
  if (!readSessionToken()) {
    throw new Error("buyer account session is required; complete first-purchase auth or run buyer checkout resume first");
  }
  const link = await coreApi("/v1/me/portal-login-links", { method: "POST" }, flags);
  output(buyerRunOutput({
    status: "account_portal_login_link_created",
    account_id: accountID,
    portal_login_link: link,
    login_url: link.login_url,
    expires_at: link.expires_at,
    agent_next_actions: link.agent_next_actions || ["show_login_link_to_human_only"],
    next: {
      type: "human_open_account_portal_link",
      safe_for_agent: false,
      requires_human: true,
      agent_must_not_open: true,
      instruction: "Give this one-time ItPay account portal link to the human buyer. Do not open it yourself; the human portal is redacted and protected content stays locked until human reveal."
    }
  }));
}

async function accountSetPassword(flags) {
  if (!flags.password_stdin) {
    throw new Error("use --password-stdin to avoid leaking passwords into shell history");
  }
  const password = fs.readFileSync(0, "utf8").trim();
  if (!password) throw new Error("password is required on stdin");
  output(await api("/api/itp/account/password", {
    method: "POST",
    body: { password }
  }, flags));
}

async function plansList(flags) {
  output(await api("/api/itp/plans", { method: "GET" }, flags));
}

async function plansShow(plan, flags) {
  if (!plan) throw new Error("plan id is required");
  output(await api(`/api/itp/plans/${encodeURIComponent(plan)}`, { method: "GET" }, flags));
}

async function checkoutCreate(flags) {
  const response = await createCheckoutResult(flags);
  await renderHumanAction(response.human_action, flags);
  output(response);
}

async function createCheckoutResult(flags) {
  const purchase = normalizePurchaseFlags(flags, true);
  const method = flags.method || "alipay";
  validateLivePaymentFlags(method, flags);
  const currentRun = readRun(flags.run_id || readState().current_run_id);
  const idempotencyKey = flags.idempotency_key || currentRun?.idempotency_key || cryptoRandom();
  const body = {
    payment_method: method,
    idempotency_key: idempotencyKey
  };
  if (purchase.plan) body.plan_id = purchase.plan;
  if (purchase.credits) body.credits = purchase.credits;
  const response = await api("/api/itp/checkout", {
    method: "POST",
    body
  }, flags);
  writeState({ ...readState(), last_checkout_id: response.checkout_id, last_grant_id: response.grant_id || null });
  updateCurrentRun({
    phase: response.grant_id ? "grant_ready" : "waiting_human_payment",
    plan_id: response.plan_id || purchase.plan || null,
    credits: response.credits || purchase.credits || null,
    purchase_kind: response.purchase?.kind || purchase.kind,
    checkout: {
      checkout_id: response.checkout_id,
      order_id: response.order_id,
      status: response.status,
      expires_at: response.expires_at,
      purchase: response.purchase || null
    },
    payment: {
      provider: method,
      status: response.status
    },
    grant: {
      ...(currentRun?.grant || {}),
      grant_id: response.grant_id || currentRun?.grant?.grant_id || null
    },
    human_action: response.human_action || null,
    safe_summary: response.grant_id ? "Payment verified and grant is ready." : "Waiting for Alipay or WeChat Pay payment scan."
  }, flags);
  return response;
}

function validateLivePaymentFlags(method, flags = {}) {
  if (String(method).toLowerCase() === "fake" && !fakeTestingAllowed(flags)) {
    throw new Error("fake payment is developer-only and disabled for agent runs; use --method alipay for local, sandbox, and live testing");
  }
  if ((flags.mock_approve || process.env.ITPAY_MOCK_APPROVE === "true" || process.env.ITPAY_MOCK_APPROVE === "1") && !fakeTestingAllowed(flags)) {
    throw new Error("mock approval is developer-only and disabled for agent runs; use real Alipay sandbox authentication");
  }
}

function fakeTestingAllowed(flags = {}) {
  return flags.allow_fake || process.env.ITP_ALLOW_FAKE_PAYMENT === "true" || process.env.ITP_ALLOW_FAKE_PAYMENT === "1";
}

async function paymentWait(checkoutId, flags) {
  output(await paymentWaitResult(checkoutId, flags));
}

async function paymentWaitResult(checkoutId, flags) {
  if (!checkoutId) throw new Error("checkout_id is required");
  const started = Date.now();
  const timeoutMs = Number(flags.timeout || 120) * 1000;
  let lastRecoverAt = 0;
  let lastHeartbeatAt = 0;
  let lastResponse = null;
  while (Date.now() - started < timeoutMs) {
    let response = await api(`/api/itp/checkout/${encodeURIComponent(checkoutId)}`, { method: "GET" }, flags);
    lastResponse = response;
    if (isTerminalCheckoutFailure(response.status)) {
      throw new Error(`checkout ended with status: ${response.status}`);
    }
    if (isSuccessfulCheckout(response)) {
      writeState({ ...readState(), last_checkout_id: checkoutId, last_grant_id: response.grant_id });
      updateCurrentRun({
        phase: "grant_ready",
        checkout: { checkout_id: checkoutId, order_id: response.order_id, status: response.status, expires_at: response.expires_at },
        grant: { grant_id: response.grant_id, installed: false },
        human_action: null,
        safe_summary: "Payment verified and grant is ready."
      }, flags);
      return { status: "grant_issued", checkout_id: checkoutId, order_id: response.order_id, grant_id: response.grant_id };
    }
    if (shouldRecoverCheckout(response.status) && Date.now() - lastRecoverAt > 5000) {
      lastRecoverAt = Date.now();
      response = await api(`/api/itp/checkout/${encodeURIComponent(checkoutId)}/recover`, { method: "POST" }, flags);
      lastResponse = response;
      if (isTerminalCheckoutFailure(response.status)) {
        throw new Error(`checkout ended with status: ${response.status}`);
      }
      if (isSuccessfulCheckout(response)) {
        writeState({ ...readState(), last_checkout_id: checkoutId, last_grant_id: response.grant_id });
        updateCurrentRun({
          phase: "grant_ready",
          checkout: { checkout_id: checkoutId, order_id: response.order_id, status: response.status, expires_at: response.expires_at },
          grant: { grant_id: response.grant_id, installed: false },
          human_action: null,
          safe_summary: "Payment verified and grant is ready."
        }, flags);
        return { status: "grant_issued", checkout_id: checkoutId, order_id: response.order_id, grant_id: response.grant_id, recovered: true };
      }
    }
    lastHeartbeatAt = writeWaitHeartbeat({
      kind: "Alipay or WeChat Pay payment",
      idName: "checkout_id",
      idValue: checkoutId,
      status: response.status || "waiting",
      action: response.human_action || null,
      lastHeartbeatAt,
      flags,
      command: cliCommand("payment", "wait", checkoutId, "--timeout", String(Math.ceil((timeoutMs - (Date.now() - started)) / 1000)), "--json")
    });
    await sleep(2000);
  }
  try {
    const response = await api(`/api/itp/checkout/${encodeURIComponent(checkoutId)}/recover`, { method: "POST" }, flags);
    lastResponse = response;
    if (isTerminalCheckoutFailure(response.status)) {
      throw new Error(`checkout ended with status: ${response.status}`);
    }
    if (isSuccessfulCheckout(response)) {
      writeState({ ...readState(), last_checkout_id: checkoutId, last_grant_id: response.grant_id });
      updateCurrentRun({
        phase: "grant_ready",
        checkout: { checkout_id: checkoutId, order_id: response.order_id, status: response.status, expires_at: response.expires_at },
        grant: { grant_id: response.grant_id, installed: false },
        human_action: null,
        safe_summary: "Payment verified and grant is ready."
      }, flags);
      return { status: "grant_issued", checkout_id: checkoutId, order_id: response.order_id, grant_id: response.grant_id, recovered: true };
    }
  } catch (error) {
    if (isTerminalCheckoutFailure(lastResponse?.status)) {
      throw error;
    }
    // Preserve the timeout message below; recover is a best-effort final attempt.
  }
  if (lastResponse?.status) {
    throw new Error(`payment wait timed out at checkout status ${lastResponse.status}; run \`itp checkout recover ${checkoutId}\` later`);
  }
  throw new Error("payment wait timed out; run `itp checkout recover` later");
}

async function checkoutRecover(checkoutId, flags) {
  if (!checkoutId) throw new Error("checkout_id is required");
  const response = await api(`/api/itp/checkout/${encodeURIComponent(checkoutId)}/recover`, { method: "POST" }, flags);
  if (response.grant_id) {
    writeState({ ...readState(), last_checkout_id: checkoutId, last_grant_id: response.grant_id });
  }
  output(response);
}

async function checkoutOpen(flags) {
  const state = readState();
  if (!state.last_checkout_id) throw new Error("no checkout found in local state");
  const response = await api(`/api/itp/checkout/${encodeURIComponent(state.last_checkout_id)}`, { method: "GET" }, flags);
  output(response.payment || response);
}

async function checkoutQR(checkoutId, flags) {
  if (!checkoutId) throw new Error("checkout_id is required");
  const response = await api(`/api/itp/checkout/${encodeURIComponent(checkoutId)}/qr`, { method: "GET" }, flags);
  await renderHumanAction(response.human_action, flags);
  output(response);
}

async function checkoutList(flags) {
  const params = new URLSearchParams();
  if (flags.limit) params.set("limit", flags.limit);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  output(await api(`/api/itp/orders${suffix}`, { method: "GET" }, flags));
}

async function balance(flags) {
  output(await api("/api/itp/balance", { method: "GET" }, flags));
}

async function usage(flags) {
  const params = new URLSearchParams();
  if (flags.model) params.set("model", flags.model);
  if (flags.grant) params.set("grant_id", flags.grant);
  if (flags.grant_id) params.set("grant_id", flags.grant_id);
  if (flags.from) params.set("from", flags.from);
  if (flags.to) params.set("to", flags.to);
  if (flags.today) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    params.set("from", Math.floor(start.getTime() / 1000).toString());
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  output(await api(`/api/itp/usage${suffix}`, { method: "GET" }, flags));
}

async function grantsList(flags) {
  output(await api("/api/itp/grants", { method: "GET" }, flags));
}

async function grantsShow(grantId, flags) {
  if (!grantId) throw new Error("grant_id is required");
  output(await api(`/api/itp/grants/${encodeURIComponent(grantId)}`, { method: "GET" }, flags));
}

async function grantsInstall(grantId, flags) {
  output(await grantsInstallResult(grantId, flags));
}

async function grantsInstallResult(grantId, flags) {
  grantId = grantId || readState().last_grant_id;
  if (!grantId) throw new Error("grant_id is required");
  const target = flags.target || "generic";
  const response = await api(`/api/itp/grants/${encodeURIComponent(grantId)}/install`, {
    method: "POST",
    body: { target }
  }, flags);
  const storedCredential = storeGrantCredential(grantId, {
    key: response.credential.key_once,
    target,
    base_url: response.base_url,
    openai_base_url: response.openai_base_url,
    anthropic_base_url: response.anthropic_base_url,
    gemini_base_url: response.gemini_base_url,
    models: response.models || [],
    install_profiles: response.install_profiles || []
  });
  const grantsDir = path.join(CONFIG_DIR, "grants");
  ensureConfigDir();
  fs.mkdirSync(grantsDir, { recursive: true });
  try {
    fs.chmodSync(grantsDir, 0o700);
  } catch {
    // Best effort; grant metadata does not contain gateway keys.
  }
  const metadataPath = path.join(grantsDir, `${grantId}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify({
    grant_id: grantId,
    target,
    base_url: response.base_url,
    models: response.models,
    install_profiles: response.install_profiles
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(metadataPath, 0o600);
  writeState({ ...readState(), last_grant_id: grantId });
  updateCurrentRun({
    phase: "grant_ready",
    grant: {
      grant_id: grantId,
      installed: true,
      credential_store: storedCredential.credential_store || null
    },
    result: {
      base_url: response.base_url,
      openai_base_url: response.openai_base_url,
      anthropic_base_url: response.anthropic_base_url,
      gemini_base_url: response.gemini_base_url
    },
    safe_summary: "Grant credential stored."
  }, flags);
  return {
    ...response,
    credential: {
      type: response.credential.type,
      stored: true,
      credential_store: storedCredential.credential_store,
      warning: storedCredential.credential_warning || undefined
    }
  };
}

async function grantsRevoke(grantId, flags) {
  grantId = grantId || flags.grant || readState().last_grant_id;
  if (!grantId) throw new Error("grant_id is required");
  const response = await api(`/api/itp/grants/${encodeURIComponent(grantId)}/revoke`, { method: "POST" }, flags);
  deleteGrantCredential(grantId);
  const state = readState();
  if (state.last_grant_id === grantId) {
    delete state.last_grant_id;
    writeState(state);
  }
  output(response);
}

async function installRuntime(target, flags) {
  output(await installRuntimeResult(target, flags));
}

async function installRuntimeResult(target, flags) {
  const grantId = flags.grant || readState().last_grant_id;
  if (!grantId) throw new Error("grant id is required");
  const credentials = readGrantCredential(grantId);
  if (!credentials) throw new Error(`grant ${grantId} is not installed; run grants install first`);
  if (!credentials.key) {
    throw new Error(`grant ${grantId} credential key is unavailable; run keys rotate or grants install again`);
  }

  const dryRun = Boolean(flags.dry_run);
  const result = installTargetConfig(target, grantId, credentials, dryRun);
  const shouldTest = !dryRun && !flags.offline && !flags.no_test;
  const modelCheck = shouldTest
    ? await doctorModelCheck(target, credentials)
    : { attempted: false, skipped: true, reason: dryRun ? "dry_run" : flags.offline ? "offline" : "no_test" };
  result.model_check = modelCheck;
  result.tested = Boolean(modelCheck.ok);
  if (modelCheck.attempted && !modelCheck.ok) {
    result.warnings.push(`Model endpoint check failed: ${modelCheck.error || modelCheck.status || "unknown error"}`);
  }

  if (!dryRun && !flags.offline) {
    await api(`/api/itp/grants/${encodeURIComponent(grantId)}/install-ack`, {
      method: "POST",
      body: {
        target,
        status: "installed",
        tested: result.tested,
        config_path: result.files[0]?.path || "",
        last_error: result.warnings.join("; ")
      }
    }, flags);
  }
  return result;
}

function shouldRecoverCheckout(status) {
  return ["paid_verified", "granting", "grant_failed"].includes(status);
}

function isSuccessfulCheckout(response) {
  return Boolean(response?.grant_id) && ["grant_issued", "grant_installed"].includes(response.status);
}

function isTerminalCheckoutFailure(status) {
  return ["expired", "payment_failed", "verify_failed", "amount_mismatch", "revoked"].includes(status);
}

function installTargetConfig(target, grantId, credentials, dryRun) {
  if (target === "codex") return installCodex(grantId, credentials, dryRun);
  if (target === "claude-code") return installClaudeCode(grantId, credentials, dryRun);
  if (target === "openclaw") return installOpenClaw(grantId, credentials, dryRun);
  throw new Error(`unsupported install target: ${target}`);
}

function installClaudeCode(grantId, credentials, dryRun) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const current = readJSON(settingsPath, {});
  current.env = {
    ...(current.env || {}),
    ANTHROPIC_BASE_URL: credentials.anthropic_base_url,
    ANTHROPIC_AUTH_TOKEN_HELPER: `${quoteShell(currentExecutable())} token issue --grant ${quoteShell(grantId)} --stdout`
  };
  delete current.env.ANTHROPIC_API_KEY;
  const write = writeJSONWithBackup(settingsPath, current, dryRun);
  return {
    target: "claude-code",
    grant_id: grantId,
    status: dryRun ? "dry_run" : "installed",
    files: [{ path: settingsPath, action: write.action, backup_path: write.backup_path || null }],
    warnings: [
      "Claude Code will call itp as an auth token helper; no gateway key was written to settings.json."
    ]
  };
}

function installCodex(grantId, credentials, dryRun) {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const envPath = path.join(CONFIG_DIR, "itpay.env");
  const existing = readText(configPath, "");
  const block = [
    'model_provider = "itpay"',
    'model = "openai-code-default"',
    "",
    "[model_providers.itpay]",
    'name = "ItPay"',
    `base_url = "${escapeTomlString(credentials.openai_base_url)}"`,
    'env_key = "ITPAY_API_KEY"'
  ].join("\n");
  const nextConfig = replaceManagedBlock(existing, "itpay", block);
  const configWrite = writeTextWithBackup(configPath, nextConfig, 0o600, dryRun);
  const envWrite = writeTextWithBackup(envPath, `export ITPAY_API_KEY=${quoteShell(credentials.key)}\n`, 0o600, dryRun);
  return {
    target: "codex",
    grant_id: grantId,
    status: dryRun ? "dry_run" : "installed",
    files: [
      { path: configPath, action: configWrite.action, backup_path: configWrite.backup_path || null },
      { path: envPath, action: envWrite.action, backup_path: envWrite.backup_path || null }
    ],
    warnings: [
      "Codex reads ITPAY_API_KEY from its process environment; source ~/.itp/itpay.env before starting Codex if your launcher does not load it."
    ]
  };
}

function installOpenClaw(grantId, credentials, dryRun) {
  const configPath = path.join(os.homedir(), ".openclaw", "config.json");
  const current = readJSON(configPath, {});
  current.models = current.models || {};
  current.models.providers = current.models.providers || {};
  current.models.providers.itpay = {
    baseUrl: credentials.openai_base_url,
    api: "openai-compatible",
    apiKey: credentials.key,
    models: credentials.models || []
  };
  const write = writeJSONWithBackup(configPath, current, dryRun);
  return {
    target: "openclaw",
    grant_id: grantId,
    status: dryRun ? "dry_run" : "installed",
    files: [{ path: configPath, action: write.action, backup_path: write.backup_path || null }],
    warnings: [
      "OpenClaw does not expose a stable token-helper contract here, so the key is written only to the user-level config file with 0600 permissions."
    ]
  };
}

async function doctor(flags) {
  const config = readConfig();
  const credentials = readCredentials();
  const target = flags.target || null;
  const grantId = flags.grant || readState().last_grant_id || null;
  const grantCredential = grantId ? readGrantCredential(grantId) : null;
  output({
    itp_version: VERSION,
    api_base: apiBase(flags),
    account_id: config.account_id || null,
    device_id: config.device_id || null,
    authenticated: Boolean(readSessionToken(credentials)),
    grants_cached: Object.keys(credentials).filter((k) => k.startsWith("grant_")).length,
    grant_id: grantId,
    target,
    target_config: target ? runtimeConfigStatus(target) : null,
    model_check: grantCredential && !flags.offline ? await doctorModelCheck(target, grantCredential) : null,
    grant_credential_store: grantCredential?.credential_store || null,
    warning: grantCredential?.credential_warning || undefined,
    credential_store: {
      path: CREDENTIALS_PATH,
      mode: fileMode(CREDENTIALS_PATH),
      native: detectNativeCredentialStore(),
      fallback: true
    },
    session_credential_store: credentials.session_token_store || (credentials.session_token ? "file" : null),
    session_credential_warning: credentials.session_token_warning || undefined
  });
}

async function doctorModelCheck(target, credentials) {
  const baseUrl = target === "claude-code"
    ? credentials.anthropic_base_url
    : target === "codex" || target === "openclaw"
      ? credentials.openai_base_url
      : credentials.openai_base_url || credentials.base_url;
  if (!baseUrl || !credentials.key) {
    return { attempted: false, ok: false, error: "missing base_url or credential" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${credentials.key}` },
      signal: controller.signal
    });
    return {
      attempted: true,
      ok: response.ok,
      status: response.status,
      endpoint: `${baseUrl.replace(/\/$/, "")}/models`
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      endpoint: `${baseUrl.replace(/\/$/, "")}/models`,
      error: error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function runtimeConfigStatus(target) {
  const paths = {
    "claude-code": [path.join(os.homedir(), ".claude", "settings.json")],
    codex: [path.join(os.homedir(), ".codex", "config.toml"), path.join(CONFIG_DIR, "itpay.env")],
    openclaw: [path.join(os.homedir(), ".openclaw", "config.json")]
  };
  return (paths[target] || []).map((file) => ({
    path: file,
    exists: fs.existsSync(file),
    mode: fileMode(file)
  }));
}

async function keys(command, flags) {
  const credentials = readCredentials();
  const grants = Object.entries(credentials)
    .filter(([key]) => key.startsWith("grant_"))
    .map(([key, value]) => ({
      grant_id: key.slice("grant_".length),
      target: value.target,
      base_url: value.base_url,
      credential_store: value.credential_store || "file",
      key: value.key ? maskSecret(value.key) : "stored"
    }));
  if (!command || command === "list") {
    output({ keys: grants });
    return;
  }
  if (command === "revoke") {
    const grantId = flags.grant || grants[0]?.grant_id;
    if (!grantId) throw new Error("grant id is required");
    const response = await api(`/api/itp/grants/${encodeURIComponent(grantId)}/revoke`, { method: "POST" }, flags);
    deleteGrantCredential(grantId);
    output(response);
    return;
  }
  if (command === "rotate") {
    const grantId = flags.grant || grants[0]?.grant_id;
    if (!grantId) throw new Error("grant id is required");
    const existing = readCredentials()[`grant_${grantId}`] || {};
    const response = await api(`/api/itp/grants/${encodeURIComponent(grantId)}/rotate`, { method: "POST" }, flags);
    const storedCredential = storeGrantCredential(grantId, {
      key: response.credential.key_once,
      target: existing.target || flags.target || "",
      base_url: response.base_url,
      openai_base_url: response.openai_base_url,
      anthropic_base_url: response.anthropic_base_url,
      gemini_base_url: response.gemini_base_url,
      models: response.models || [],
      install_profiles: response.install_profiles || []
    });
    output({
      ...response,
      credential: {
        type: response.credential.type,
        rotated: true,
        stored: true,
        credential_store: storedCredential.credential_store,
        warning: storedCredential.credential_warning || undefined
      }
    });
    return;
  }
  throw new Error(`unknown keys command: ${command}`);
}

async function token(command, flags) {
  if (command !== "issue") throw new Error(`unknown token command: ${command || ""}`);
  const grantId = flags.grant || readState().last_grant_id;
  if (!grantId) throw new Error("grant id is required");
  const credentials = readGrantCredential(grantId);
  if (!credentials?.key) throw new Error(`grant ${grantId} is not installed locally`);
  if (flags.stdout) {
    process.stdout.write(credentials.key);
    return;
  }
  output({
    grant_id: grantId,
    key: maskSecret(credentials.key),
    stdout_required_for_raw_token: true
  });
}

async function sync(flags) {
  const [account, balanceResult, grants] = await Promise.all([
    api("/api/itp/account", { method: "GET" }, flags),
    api("/api/itp/balance", { method: "GET" }, flags),
    api("/api/itp/grants", { method: "GET" }, flags)
  ]);
  output({ account, balance: balanceResult, grants });
}

async function refreshRun(run, flags = {}) {
  let next = { ...run };
  const credentials = readCredentials();
  const hasSession = Boolean(readSessionToken(credentials));

  if (next.auth?.auth_id && !hasSession) {
    try {
      const auth = await api(`/api/itp/auth/device/${encodeURIComponent(next.auth.auth_id)}/poll`, { method: "POST" }, flags);
      if (auth.auth?.session_token) {
        writeSessionCredentials(auth.auth);
        writeConfig({
          api_base: apiBase(flags),
          account_id: auth.auth.account_id,
          device_id: auth.auth.device_id,
          web_console_url: auth.auth.web_console_url
        });
        next = mergeRun(next, {
          phase: "authenticated",
          status: "running",
          account: {
            authenticated: true,
            account_id: auth.auth.account_id,
            device_id: auth.auth.device_id,
            newapi_user_id: auth.auth.newapi_user_id || null
          },
          auth: { status: "consumed" },
          human_action: null,
          safe_summary: "Agent device authenticated."
        });
      } else if (auth.status === "authorization_pending") {
        next = mergeRun(next, {
          phase: "waiting_human_auth",
          status: "waiting_human_auth",
          auth: { status: "pending", expires_at: auth.expires_at },
          human_action: auth.human_action || auth.next_action?.human_action || next.human_action || null,
          safe_summary: "Waiting for Alipay authentication scan."
        });
      } else if (auth.status) {
        next = mergeRun(next, {
          phase: auth.status === "expired" ? "expired" : "failed",
          status: auth.status === "expired" ? "expired" : "failed",
          auth: { status: auth.status },
          safe_summary: auth.error || `Auth status: ${auth.status}`
        });
      }
    } catch (error) {
      next = mergeRun(next, { last_error: safeErrorMessage(error), safe_summary: "Could not refresh auth status." });
    }
  }

  if (readSessionToken(readCredentials())) {
    try {
      const authStatusResult = await api("/api/itp/auth/status", { method: "GET" }, flags);
      next = mergeRun(next, {
        account: {
          authenticated: authStatusResult.authenticated !== false,
          account_id: authStatusResult.account_id || next.account?.account_id || null,
          device_id: authStatusResult.device_id || next.account?.device_id || null,
          newapi_user_id: authStatusResult.newapi_user_id || null
        }
      });
    } catch (error) {
      next = mergeRun(next, { last_error: safeErrorMessage(error) });
    }
  }

  if (next.checkout?.checkout_id && readSessionToken(readCredentials())) {
    try {
      const checkout = await api(`/api/itp/checkout/${encodeURIComponent(next.checkout.checkout_id)}`, { method: "GET" }, flags);
      next = mergeRun(next, {
        phase: checkout.grant_id ? "grant_ready" : checkout.status === "waiting_user_payment" ? "waiting_human_payment" : next.phase,
        status: checkout.grant_id ? "grant_ready" : checkout.status === "waiting_user_payment" ? "waiting_human_payment" : next.status,
        checkout: {
          checkout_id: checkout.checkout_id,
          order_id: checkout.order_id,
          status: checkout.status,
          expires_at: checkout.expires_at
        },
        payment: { provider: next.payment_method, status: checkout.status },
        grant: { ...(next.grant || {}), grant_id: checkout.grant_id || next.grant?.grant_id || null },
        human_action: checkout.human_action || null,
        safe_summary: checkout.grant_id ? "Payment verified and grant is ready." : checkout.status === "waiting_user_payment" ? "Waiting for Alipay or WeChat Pay payment scan." : `Checkout status: ${checkout.status}`
      });
    } catch (error) {
      next = mergeRun(next, { last_error: safeErrorMessage(error), safe_summary: "Could not refresh checkout status." });
    }
  }

  const grantId = next.grant?.grant_id || readState().last_grant_id;
  if (grantId) {
    const credential = readGrantCredential(grantId);
    if (credential?.key || credential?.credential_ref) {
      next = mergeRun(next, {
        phase: next.install_runtime ? next.phase : "grant_ready",
        grant: { grant_id: grantId, installed: true, credential_store: credential.credential_store || "file" },
        safe_summary: "Grant credential stored."
      });
    }
  }
  return next;
}

function agentRunResponse(run, extra = {}) {
  const status = extra.status || (run.status && run.status !== "running" ? run.status : phaseToStatus(run.phase));
  return {
    schema_version: "itp.agent.v1",
    status,
    run_id: run.run_id,
    phase: run.phase || status,
    auth_id: extra.auth_id || run.auth?.auth_id || null,
    account_id: extra.account_id || run.account?.account_id || null,
    device_id: extra.device_id || run.account?.device_id || null,
    checkout_id: extra.checkout_id || run.checkout?.checkout_id || null,
    order_id: extra.order_id || run.checkout?.order_id || null,
    grant_id: extra.grant_id || run.grant?.grant_id || null,
    plan_id: extra.plan_id || run.plan_id || null,
    credits: extra.credits || run.credits || run.checkout?.purchase?.credits_granted || null,
    purchase: extra.purchase || run.checkout?.purchase || undefined,
    target: extra.target || run.target || "generic",
    base_url: extra.base_url || run.result?.base_url || undefined,
    openai_base_url: extra.openai_base_url || run.result?.openai_base_url || undefined,
    anthropic_base_url: extra.anthropic_base_url || run.result?.anthropic_base_url || undefined,
    gemini_base_url: extra.gemini_base_url || run.result?.gemini_base_url || undefined,
    credential: extra.credential || (run.grant?.installed ? {
      stored: true,
      credential_store: run.grant?.credential_store,
      token_command: run.grant?.grant_id ? cliCommand("token", "issue", "--grant", run.grant.grant_id, "--stdout") : undefined,
      stdout_required_for_raw_token: true
    } : undefined),
    human_action: extra.human_action || run.human_action || undefined,
    next: extra.next || nextActionForRun(run),
    next_action: extra.next_action || undefined,
    recoverable_context: extra.recoverable_context || undefined,
    safe_user_message: extra.safe_user_message || safeUserMessageForRun(run),
    safe_summary: run.safe_summary || undefined,
    warnings: extra.warnings || [],
    secrets: {
      raw_key_included: false,
      session_token_included: false
    },
    ...extra
  };
}

function phaseToStatus(phase) {
  if (phase === "waiting_human_auth") return "waiting_human_auth";
  if (phase === "waiting_human_payment") return "waiting_human_payment";
  if (phase === "grant_ready") return "grant_ready";
  if (phase === "done") return "done";
  if (phase === "expired") return "expired";
  if (phase === "failed") return "failed";
  return phase || "running";
}

function nextActionForRun(run) {
  if (run.phase === "waiting_human_auth") {
    return { type: "show_qr_and_wait", command: resumeCommand(run, runResumeFlags(run)), retry_after_ms: 2000, safe_for_agent: true };
  }
  if (run.phase === "waiting_human_payment") {
    return { type: "show_qr_and_wait", command: resumeCommand(run, runResumeFlags(run, { display: "none" })), retry_after_ms: 2000, safe_for_agent: true };
  }
  if (["paid_verified", "granting", "grant_failed"].includes(run.checkout?.status)) {
    return { type: "recover_checkout", command: cliCommand("checkout", "recover", run.checkout.checkout_id, "--json"), safe_for_agent: true };
  }
  if (run.grant?.grant_id && !run.grant?.installed) {
    return { type: "install_grant", command: cliCommand("grants", "install", run.grant.grant_id, "--target", run.target || "generic", "--json"), safe_for_agent: true };
  }
  if (run.grant?.installed) {
    return { type: "done", safe_for_agent: true };
  }
  return { type: "resume", command: resumeCommand(run, runResumeFlags(run)), safe_for_agent: true };
}

function runResumeFlags(run, overrides = {}) {
  return {
    host: run.agent_host || undefined,
    display: run.agent_display || undefined,
    qr_format: run.agent_qr_format || undefined,
    api_base: run.api_base || undefined,
    ...overrides
  };
}

function resumeCommand(run, flags = {}, options = {}) {
  const args = ["resume", "--run-id", run.run_id, "--json"];
  appendPassthroughFlag(args, flags, "host");
  appendPassthroughFlag(args, flags, "display");
  appendPassthroughFlag(args, flags, "qr_format", "qr-format");
  appendPassthroughFlag(args, flags, "api_base", "api-base");
  appendPassthroughFlag(args, flags, "api_timeout", "api-timeout");
  if (options.no_wait_payment) args.push("--no-wait-payment");
  return cliCommand(...args);
}

function appendPassthroughFlag(args, flags, key, flagName = key) {
  const value = flags[key];
  if (value === undefined || value === null || value === false) return;
  args.push(`--${flagName}`);
  if (value !== true) args.push(String(value));
}

function safeUserMessageForRun(run) {
  if (run.phase === "waiting_human_auth") return "Please scan the Alipay authentication QR. I will continue automatically after approval.";
  if (run.phase === "waiting_human_payment") return "Please scan the Alipay or WeChat Pay payment QR. I will continue automatically after payment is verified.";
  if (run.grant?.installed) return "Payment verified. The API credential is stored locally.";
  return run.safe_summary || "ITPay setup is in progress.";
}

function recoverableRuntimeRunContext(run = {}) {
  if (!run || !run.run_id) return noRecoverableContext();
  const status = String(run.status || run.phase || "").toLowerCase();
  const terminal = ["done", "installed", "failed", "expired"].includes(status) || run.phase === "done";
  if (terminal) return noRecoverableContext();
  return {
    found: true,
    kind: "runtime_run",
    run_id: run.run_id,
    status: run.status || null,
    phase: run.phase || null,
    checkout_id: run.checkout?.checkout_id || null,
    order_id: run.checkout?.order_id || null,
    grant_id: run.grant?.grant_id || null,
    resume_command: cliCommand("resume", "--run-id", run.run_id, "--json"),
    status_command: cliCommand("status", "--refresh", "--run-id", run.run_id, "--json"),
    intent_check: recoverableIntentCheckGuidance(run),
    safe_choices: [
      { choice: "continue_old_task", when: "当前用户是在继续这次 setup/auth/payment/grant 安装流程。", action: cliCommand("resume", "--run-id", run.run_id, "--json") },
      { choice: "ignore_old_task", when: "当前用户明确要求新的、不相关的任务。", action: "按当前用户意图继续，不要自动 resume。" },
      { choice: "ask_human", when: "无法判断旧 run 是否相关，或涉及付款/授权/退款。", action: "向用户确认是否继续旧 run。" }
    ],
    guidance: "发现未完成 run 后，先判断它是否属于当前用户意图。相关则 resume；明确不相关可忽略；不确定必须问人类。"
  };
}

export { authRegister, setup, agentStatus, refreshBuyerSessionForStatus, nextActionForAuthStatus, resume, runs, startDeviceAuth, completeDeviceAuth, ensureAuthenticated, maybeMockApproveDeviceAuth, authDevice, waitDeviceAuth, authLogin, authStatus, accountShow, accountLoginLink, accountSetPassword, plansList, plansShow, checkoutCreate, createCheckoutResult, validateLivePaymentFlags, fakeTestingAllowed, paymentWait, paymentWaitResult, checkoutRecover, checkoutOpen, checkoutQR, checkoutList, balance, usage, grantsList, grantsShow, grantsInstall, grantsInstallResult, grantsRevoke, installRuntime, installRuntimeResult, shouldRecoverCheckout, isSuccessfulCheckout, isTerminalCheckoutFailure, installTargetConfig, installClaudeCode, installCodex, installOpenClaw, doctor, doctorModelCheck, runtimeConfigStatus, keys, token, sync, refreshRun, agentRunResponse, phaseToStatus, nextActionForRun, runResumeFlags, resumeCommand, appendPassthroughFlag, safeUserMessageForRun, recoverableRuntimeRunContext };
