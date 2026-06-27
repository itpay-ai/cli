import { coreApi } from "./http.js";
import { noRecoverableContext } from "./buyer.js";
import { cliCommand, output, readConfig, readCredentials, readSessionToken, safeErrorMessage } from "./env.js";

async function accountOverviewStatus(flags = {}) {
  const config = readConfig();
  const credentials = readCredentials();
  const hasLocalSession = Boolean(readSessionToken(credentials) || flags.access_token);
  const base = {
    schema_version: "itp.agent.v1",
    status: hasLocalSession ? "account_status_unavailable" : "unauthenticated",
    phase: hasLocalSession ? "account_status_unavailable" : "unauthenticated",
    authenticated: false,
    session_verified: !hasLocalSession,
    auth_source: hasLocalSession ? "local_files_unverified" : "local_files",
    account_id: config.account_id || null,
    buyer_account_id: config.account_id || null,
    device_id: config.device_id || null,
    agent_device_id: config.device_id || null,
    linked_providers: [],
    order_count: 0,
    created_at: null,
    device: config.device_id ? { agent_device_id: config.device_id } : null,
    next: hasLocalSession
      ? { type: "retry_status", command: cliCommand("status", "--json"), safe_for_agent: true }
      : { type: "start_auth", command: cliCommand("setup", "--plan", "credit-300", "--method", "alipay", "--json"), safe_for_agent: true },
    recoverable_context: noRecoverableContext(),
    agent_next_actions: hasLocalSession
      ? ["run_status_refresh", "view_orders", "create_refund_if_needed", "list_agent_read_grants"]
      : ["start_human_auth_if_unauthenticated"],
    secrets: { raw_key_included: false, session_token_included: false }
  };
  if (!hasLocalSession) return base;

  try {
    const me = await coreApi("/v1/me", { method: "GET" }, flags);
    const authenticated = Boolean(me.authenticated);
    const accountID = me.buyer_account_id || config.account_id || null;
    const deviceID = me.agent_device_id || me.device?.agent_device_id || config.device_id || null;
    return {
      ...base,
      status: authenticated ? "idle" : "unauthenticated",
      phase: authenticated ? "idle" : "unauthenticated",
      authenticated,
      session_verified: true,
      auth_source: "core",
      account_id: accountID,
      buyer_account_id: accountID,
      device_id: deviceID,
      agent_device_id: deviceID,
      linked_providers: Array.isArray(me.linked_providers) ? me.linked_providers : [],
      order_count: Number.isFinite(Number(me.order_count)) ? Number(me.order_count) : 0,
      created_at: me.created_at || null,
      device: me.device || (deviceID ? { agent_device_id: deviceID } : null),
      next: authenticated
        ? { type: "buyer_ready", command: cliCommand("buyer", "auth", "status", "--json"), safe_for_agent: true }
        : base.next,
      agent_next_actions: authenticated
        ? ["search_catalog", "view_orders", "create_refund_if_needed", "list_agent_read_grants"]
        : ["start_human_auth_if_unauthenticated"],
      backend: {
        environment: me.environment || null,
        backend_version: me.backend_version || null
      }
    };
  } catch (error) {
    return {
      ...base,
      error: safeErrorMessage(error)
    };
  }
}

function outputAccountStatus(status, flags = {}) {
  if (flags.json) {
    output(status);
    return;
  }
  console.log(formatStatusText(status));
}

function formatStatusText(status = {}) {
  if (!status.authenticated) {
    const lines = [
      `Account:  ${status.account_id ? `${status.account_id} (unverified)` : "not signed in"}`,
      "Linked:   -",
      "Orders:   -",
      `Device:   ${formatDeviceLine(status.device, status.device_id) || "-"}`
    ];
    if (status.error) lines.push(`Error:    ${status.error}`);
    return lines.join("\n");
  }
  const linked = Array.isArray(status.linked_providers) && status.linked_providers.length
    ? status.linked_providers.join(", ")
    : "-";
  return [
    `Account:  ${status.buyer_account_id || status.account_id || "-"}`,
    `Linked:   ${linked}`,
    `Orders:   ${Number.isFinite(Number(status.order_count)) ? Number(status.order_count) : 0}`,
    `Device:   ${formatDeviceLine(status.device, status.device_id) || "-"}`
  ].join("\n");
}

function formatDeviceLine(device, fallbackID = "") {
  const displayName = String(device?.display_name || "").trim();
  const deviceID = String(device?.agent_device_id || fallbackID || "").trim();
  const label = displayName || deviceID;
  if (!label) return "";
  const status = String(device?.status || "").trim();
  return status ? `${label} (${status})` : label;
}

async function refreshBuyerSessionForStatus(flags = {}) {
  const config = readConfig();
  const credentials = readCredentials();
  if (!readSessionToken(credentials)) {
    return {
      authenticated: false,
      session_verified: true,
      account_id: config.account_id || null,
      device_id: config.device_id || null,
      auth_source: "core_no_session"
    };
  }
  try {
    const status = await coreApi("/v1/me/auth/status", { method: "GET" }, flags);
    return {
      authenticated: true,
      session_verified: true,
      account_id: status.buyer_account_id || config.account_id || null,
      device_id: config.device_id || null,
      account_status: status.account_status || null,
      auth_source: "core"
    };
  } catch (error) {
    return {
      authenticated: false,
      session_verified: true,
      account_id: config.account_id || null,
      device_id: config.device_id || null,
      auth_source: "core",
      error: safeErrorMessage(error)
    };
  }
}

function nextActionForAuthStatus(auth = {}, flags = {}) {
  if (auth.authenticated && auth.session_verified === false) {
    return { type: "verify_buyer_session", command: cliCommand("status", "--refresh", "--json"), safe_for_agent: true };
  }
  if (auth.authenticated) {
    return { type: "buyer_ready", command: cliCommand("buyer", "auth", "status", "--json"), safe_for_agent: true };
  }
  return { type: "start_auth", command: cliCommand("setup", "--plan", "credit-300", "--method", "alipay", "--json"), safe_for_agent: true };
}

export { accountOverviewStatus, outputAccountStatus, refreshBuyerSessionForStatus, nextActionForAuthStatus };
