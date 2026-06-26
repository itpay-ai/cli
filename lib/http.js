import { apiBase, apiTimeoutMs, cryptoRandom, readConfig, readCredentials, readSessionToken, readState, safeErrorMessage, writeState } from "./env.js";

async function coreApi(pathname, options = {}, flags = {}) {
  const headers = { "Content-Type": "application/json" };
  const credentials = readCredentials();
  if (flags.access_token) {
    const raw = String(flags.access_token);
    headers.Authorization = raw.toLowerCase().startsWith("bearer ") ? raw : `Bearer ${raw}`;
  } else {
    const sessionToken = readSessionToken(credentials);
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }
  if (options.idempotencyKey || flags.idempotency_key) {
    headers["Idempotency-Key"] = String(options.idempotencyKey || flags.idempotency_key);
  }
  if (!options.noAgentHeaders) {
    headers["X-ItPay-Agent-Fingerprint"] = coreAgentFingerprint(flags);
    headers["X-ItPay-Agent-Name"] = coreAgentDisplayName(flags);
  }
  if (options.ops) {
    headers["X-ItPay-Ops-Token"] = sandboxOpsToken(flags);
  }
  Object.assign(headers, options.headers || {});
  if (flags.request_id) headers["X-Request-ID"] = String(flags.request_id);
  if (flags.correlation_id) headers["X-Correlation-ID"] = String(flags.correlation_id);
  const targetURL = coreURL(pathname, flags);
  const timeoutMs = apiTimeoutMs(flags);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(targetURL, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${Math.ceil(timeoutMs / 1000)}s: ${safeRequestTarget(targetURL)}`);
    }
    throw new Error(`network request failed: ${safeRequestTarget(targetURL)}: ${safeErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.error || payload.message || `request failed: ${response.status}`);
    error.status = response.status;
    if (response.status === 401 && String(pathname).startsWith("/v1/me/")) {
      error.message = "buyer session required or expired; run status --refresh --json, then run setup --method alipay --json if unauthenticated";
      error.next = [
        { type: "verify_buyer_session", command: cliCommand("status", "--refresh", "--json"), safe_for_agent: true },
        { type: "start_auth_if_needed", command: cliCommand("setup", "--method", "alipay", "--json"), safe_for_agent: true }
      ];
    }
    throw error;
  }
  return payload.data ?? payload;
}

function safeRequestTarget(target) {
  try {
    const url = new URL(String(target));
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(target).split("?")[0];
  }
}

function coreAgentFingerprint(flags = {}) {
  const explicit = flags.agent_fingerprint || flags.agent_device_fingerprint || process.env.ITPAY_AGENT_FINGERPRINT || process.env.ITPAY_AGENT_DEVICE_FINGERPRINT;
  if (explicit) return String(explicit);
  const state = readState();
  if (state.core_agent_fingerprint) return state.core_agent_fingerprint;
  const fingerprint = `itp_cli_${cryptoRandom()}`;
  writeState({ ...state, core_agent_fingerprint: fingerprint });
  return fingerprint;
}

function coreAgentDisplayName(flags = {}) {
  return String(flags.agent_name || flags.agent_display_name || process.env.ITPAY_AGENT_NAME || "ItPay CLI buyer agent");
}

function coreURL(pathname, flags = {}) {
  if (/^https?:\/\//i.test(String(pathname))) return String(pathname);
  return `${coreApiBase(flags)}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
}

function coreApiBase(flags = {}, config = readConfig()) {
  const base = flags.api_base || flags.core_api_base || process.env.ITPAY_API_BASE || process.env.ITPAY_CORE_API_BASE || process.env.ITPAY_CORE_BASE_URL || config.api_base || "https://dev.api.itpay.ai";
  return String(base).replace(/\/$/, "");
}

function sandboxOpsToken(flags = {}) {
  const token = flags.ops_token || flags.sandbox_ops_token || process.env.ITPAY_SANDBOX_OPS_TOKEN || process.env.ITPAY_OPS_TOKEN;
  if (!token) throw new Error("sandbox ops token is required; set ITPAY_SANDBOX_OPS_TOKEN or pass --ops-token");
  return String(token);
}

async function api(pathname, options, flags = {}) {
  const config = readConfig();
  const credentials = readCredentials();
  const base = apiBase(flags, config);
  const headers = { "Content-Type": "application/json" };
  if (flags.access_token) {
    headers.Authorization = String(flags.access_token);
  } else {
    const sessionToken = readSessionToken(credentials);
    if (sessionToken) {
      headers.Authorization = `Bearer ${sessionToken}`;
    }
  }
  if (flags.new_api_user || flags.new_api_user_id || flags.user_id) {
    headers["New-Api-User"] = String(flags.new_api_user || flags.new_api_user_id || flags.user_id);
  }
  const timeoutMs = apiTimeoutMs(flags);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${Math.ceil(timeoutMs / 1000)}s: ${pathname}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `request failed: ${response.status}`);
  }
  return payload.data ?? payload;
}

export { coreApi, safeRequestTarget, coreAgentFingerprint, coreAgentDisplayName, coreURL, coreApiBase, sandboxOpsToken, api };
