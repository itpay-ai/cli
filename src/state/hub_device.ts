import {agentConnectionRequest, type AgentConnectionState} from "./agent_connection.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withAsyncFileLock } from "./file_lock.js";
import { finishHubDeviceSession, recoverHubConnection, hubCredentialsPath, storedHubProfile } from "./hub_credentials.js";
import { selectedHubInstallationPath } from "./hub_installation.js";
import { CLI_VERSION, API_CONTRACT_REVISION } from "./release_identity.js";
import { HubTaskStore } from "./hub_tasks.js";
import { hubOAuthConfig, type ConnectResult, type HubOAuthConfig } from "./hub_oauth.js";

type Binding = { buyer_id: string; consumer_id: string };
type Approval = Binding & { device_approval_id: string; authorization_id: string };
type Flow = {
  handle: string;
  verification_uri_complete: string;
  device_code: string;
  poll_proof: string;
  expires_in: number;
  interval: number;
  approval_required?: true;
};
type Pending = { start_key: string; request_id?: string; intent_id?: string; original?: Binding; flow?: Flow; next_poll_at?: number; exchange_started?: true; allow_missing_original?: true };

export type DeviceResult =
  | { phase: "pending"; handle: string; url: string; approval_required?: true }
  | { phase: "connected"; binding: Binding; request_id?: string }
  | { phase: "denied" | "cancelled" | "exchange_unknown" };

const pendingPath = () => hubCredentialsPath() + ".device.json";

function readPending(path: string): Pending | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Device state is not a private regular file");
    return JSON.parse(readFileSync(path, "utf8")) as Pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function save(path: string, value: Pending): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function recordDeviceEvent(path: string, handle: string, event: string): void {
  const log = path + ".events";
  try {
    let prior = "";
    try { prior = readFileSync(log, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lines = prior.split("\n").filter(line => {
      if (!line || line.length > 2048) return false;
      try { return JSON.parse(line).at >= cutoff; } catch { return false; }
    }).slice(-499);
    lines.push(JSON.stringify({ at: new Date().toISOString(), event, auth_handle: handle }));
    // The fixed event shape and 500-row cap keep this well below 2 MiB.
    const tmp = log + "." + randomUUID();
    try {
      writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
      renameSync(tmp, log);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  } catch { /* diagnostics never change an authorization outcome */ }
}

export function hubDeviceStatus(): Record<string, unknown> {
  const state = readPending(pendingPath());
  const current = storedHubProfile();
  return {
    hub: hubOAuthConfig().resource,
    issuer: new URL(hubOAuthConfig().tokenURL).origin,
    selector: selectedHubInstallationPath() ?? null,
    cli_version: CLI_VERSION,
    contract_revision: API_CONTRACT_REVISION,
    state_directory: dirname(pendingPath()),
    phase: state?.exchange_started ? "exchange_unknown" : state ? "pending" : current?.access_token ? "connected" : "disconnected",
    auth_handle: state?.flow?.handle ?? null,
    consumer_id: current?.consumer_id ?? null,
    authorization_id: current?.authorization_id ?? null,
    request_id: state?.request_id ?? null,
  };
}

async function start(cfg: HubOAuthConfig, path: string, state?: Pending, requestID?: string): Promise<DeviceResult> {
  if (requestID && state && state.request_id !== requestID) {
    throw new Error("authorization_required: this installation already has an authorization for another request");
  }
  if (state?.flow) return pending(state.flow);
  if (!state) {
    const profile = storedHubProfile();
    if (profile && (!profile.subject || !profile.consumer_id || !profile.access_token)) {
      throw new Error("authorization_required: existing API credential requires its original authorization path");
    }
    const task = requestID ? new HubTaskStore().get(requestID) : undefined;
    if (requestID && !task) throw new Error("authorization_required: original request is not in the selected installation");
    state = {
      start_key: randomUUID(),
      ...(requestID ? { request_id: requestID } : {}),
      ...(task?.intent_id && !task.run_id ? { intent_id: task.intent_id } : {}),
      ...(profile?.subject && profile.consumer_id ? { original: { buyer_id: profile.subject, consumer_id: profile.consumer_id } } : {}),
    };
    save(path, state);
  }
  const issuer = new URL(cfg.tokenURL).origin;
  const brokerPath=hubCredentialsPath()+".agent-connection.json";
  const broker=existsSync(brokerPath)?JSON.parse(readFileSync(brokerPath,"utf8")) as {root:string;state:AgentConnectionState}:undefined;
  if(broker && (!broker.state.buyer_id || !broker.state.connection_id))throw new Error("original Agent account unavailable");
  // An original intent needing renewed spending consent keeps the existing
  // explicit Device consent path and original consumer; never expand its cap.
  const useBroker=broker&&!state.intent_id;
  const response = useBroker ? await agentConnectionRequest(broker.root,broker.state,`/v1/agent-connections/${broker.state.connection_id}/hub`,{start_key:state.start_key}) : await fetch(issuer + "/v1/oauth/device/start", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientID, resource: cfg.resource, start_key: state.start_key,
      ...(state.original ? { original_consumer_id: state.original.consumer_id } : {}),
      ...(state.intent_id ? { original_intent_id: state.intent_id } : {}) }),
  });
  if (!response.ok) {if(useBroker&&response.status===503)throw Object.assign(new Error("original Hub credential preparation pending"),{code:"agent_connection_pending"});throw new Error("authorization_required: Device authorization could not start for this installation");}
  const flow = await response.json() as Flow;
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(flow.handle) || typeof flow.device_code !== "string" || !flow.device_code ||
    typeof flow.poll_proof !== "string" || !flow.poll_proof || !Number.isSafeInteger(flow.expires_in) || flow.expires_in < 1 ||
    !Number.isSafeInteger(flow.interval) || flow.interval < 1 || flow.interval > 120) throw new Error("Device start response is incomplete");
  const url = new URL(flow.verification_uri_complete);
  if (url.origin !== issuer || url.username || url.password || url.hash) throw new Error("Device link origin mismatch");
  if(broker&&state.intent_id)flow.approval_required=true;
  state.flow = flow;
  state.next_poll_at = Date.now() + flow.interval * 1000;
  save(path, state);
  recordDeviceEvent(path, flow.handle, "auth.link_issued");
  return pending(flow);
}

function pending(flow: Flow): DeviceResult {
  return { phase: "pending", handle: flow.handle, url: flow.verification_uri_complete, ...(flow.approval_required?{approval_required:true}:{}) };
}

function validBinding(value: Partial<Approval>, clientID: string): value is Approval {
  return typeof value.device_approval_id === "string" && Boolean(value.device_approval_id) &&
    typeof value.authorization_id === "string" && Boolean(value.authorization_id) &&
    typeof value.buyer_id === "string" && Boolean(value.buyer_id) &&
    typeof value.consumer_id === "string" && value.consumer_id.startsWith(`oauth:${clientID}:`) &&
    value.consumer_id.length > `oauth:${clientID}:`.length;
}

async function serverStatus(cfg: HubOAuthConfig, flow: Flow): Promise<({ phase: string } & Partial<Approval>) | undefined> {
  try {
    const issuer = new URL(cfg.tokenURL).origin;
    const response = await fetch(`${issuer}/v1/oauth/device/${flow.handle}/status`, {
      headers: { Authorization: `Bearer ${flow.poll_proof}` }, redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "phase" in value && typeof value.phase === "string") {
        return value as { phase: string } & Partial<Approval>;
      }
    }
  } catch { /* the original flow is still the only reference */ }
  return undefined;
}

async function acknowledgeDeviceSave(cfg: HubOAuthConfig, flow: Flow): Promise<void> {
  try {
    const issuer = new URL(cfg.tokenURL).origin;
    await fetch(`${issuer}/v1/oauth/device/${flow.handle}/saved`, {
      method: "POST", headers: { Authorization: `Bearer ${flow.poll_proof}` },
      redirect: "error", signal: AbortSignal.timeout(2_500),
    });
  } catch { /* the verified credentials are already saved */ }
}

export async function restartHubDevice(): Promise<DeviceResult> {
  const cfg = hubOAuthConfig();
  const path = pendingPath();
  return withAsyncFileLock(path + ".lock", async () => {
    const state = readPending(path);
    if (!state?.flow) return start(cfg, path, state);
    const status = await serverStatus(cfg, state.flow);
    if (!status || (status.phase !== "exchanged" && status.phase !== "expired")) {
      throw new Error("authorization_required: the original Device flow has not ended");
    }
    let original = state.original;
    if (status.phase === "exchanged") {
      if (!validBinding(status, cfg.clientID) || (original &&
        (original.buyer_id !== status.buyer_id || original.consumer_id !== status.consumer_id))) {
        throw new Error("authorization_required: original Device binding unavailable");
      }
      original = { buyer_id: status.buyer_id, consumer_id: status.consumer_id };
    }
    const replacement: Pending = { start_key: randomUUID(),
      ...(original ? { original } : {}),
      ...(status.phase === "exchanged" && !storedHubProfile() ? { allow_missing_original: true } : {}),
      ...(state.request_id ? { request_id: state.request_id } : {}),
      ...(state.intent_id ? { intent_id: state.intent_id } : {}),
    };
    save(path, replacement);
    return start(cfg, path, replacement);
  });
}

export async function connectHubDevice(handle: string | undefined, waitSeconds: number, requestID?: string): Promise<DeviceResult> {
  if(!handle && existsSync(hubCredentialsPath()+".recovery.json")) {
    await recoverHubConnection();
    const recovered=storedHubProfile();
    if(!recovered?.subject || !recovered.consumer_id)throw new Error("connection_recovery_denied: verified original binding unavailable");
    return {phase:"connected",binding:{buyer_id:recovered.subject,consumer_id:recovered.consumer_id},
      ...(requestID?{request_id:requestID}:{})};
  }

  const cfg = hubOAuthConfig();
  const path = pendingPath();
  const lock = path + ".lock";
  if (handle === undefined) return withAsyncFileLock(lock, async () => start(cfg, path, readPending(path), requestID));
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const result = await withAsyncFileLock(lock, async (): Promise<{ result: DeviceResult; wait?: number }> => {
      const state = readPending(path);
      const flow = state?.flow;
      if (!state || !flow || flow.handle !== handle) throw new Error("authorization_required: Device handle does not belong to the selected installation");
      const delay = (state.next_poll_at ?? 0) - Date.now();
      if (delay > 0) return { result: pending(flow), wait: delay };
      state.next_poll_at = Date.now() + flow.interval * 1000;
      save(path, state);
      const status = await serverStatus(cfg, flow);
      if (!status) return { result: pending(flow) };
      if (status.phase === "expired") {
        recordDeviceEvent(path, flow.handle, "auth.expired");
        const replacement: Pending = { start_key: randomUUID(),
          ...(state.original ? { original: state.original } : {}),
          ...(state.request_id ? { request_id: state.request_id } : {}),
          ...(state.intent_id ? { intent_id: state.intent_id } : {}),
        };
        save(path, replacement);
        return { result: await start(cfg, path, replacement) };
      }
      if (status.phase === "denied" || status.phase === "cancelled") {
        recordDeviceEvent(path, flow.handle, "auth." + status.phase);
        unlinkSync(path);
        return { result: { phase: status.phase } };
      }
      if (status.phase === "exchanged") {
        const current = storedHubProfile();
        if (validBinding(status, cfg.clientID) && current?.subject === status.buyer_id &&
          current.consumer_id === status.consumer_id && current.authorization_id === status.authorization_id &&
          current.device_approval_id === status.device_approval_id) {
          await acknowledgeDeviceSave(cfg, flow);
          unlinkSync(path);
          return { result: { phase: "connected", binding: { buyer_id: status.buyer_id, consumer_id: status.consumer_id },
            ...(state.request_id ? { request_id: state.request_id } : {}) } };
        }
        return { result: { phase: "exchange_unknown" } };
      }
      if (status.phase !== "ready_to_exchange") return { result: pending(flow), wait: flow.interval * 1000 };
      if (!validBinding(status, cfg.clientID) || (state.original &&
        (state.original.buyer_id !== status.buyer_id || state.original.consumer_id !== status.consumer_id))) {
        throw new Error("authorization_required: Device approval does not match the original account and consumer");
      }
      if (state.exchange_started) return { result: { phase: "exchange_unknown" } };
      const brokerPath=hubCredentialsPath()+".agent-connection.json";
      if(existsSync(brokerPath)){
        const broker=JSON.parse(readFileSync(brokerPath,"utf8")) as {state:AgentConnectionState};
        if(status.buyer_id!==new URL(cfg.tokenURL).origin+"|"+broker.state.buyer_id)throw new Error("original Agent API account changed");
      }
      const binding: Binding = { buyer_id: status.buyer_id, consumer_id: status.consumer_id };
      const connected = await finishHubDeviceSession(state.original, status, cfg.resource, async () => {
        state.exchange_started = true;
        save(path, state);
        return exchange(cfg, flow);
      }, process.env, event => recordDeviceEvent(path, flow.handle, event), state.allow_missing_original);
      if (connected === "slow_down" || connected === "authorization_pending") {
        delete state.exchange_started;
        if (connected === "slow_down") flow.interval += 5;
        state.next_poll_at = Date.now() + flow.interval * 1000;
        save(path, state);
        return { result: pending(flow), wait: flow.interval * 1000 };
      }
      if (connected === "exchange_unknown") return { result: { phase: "exchange_unknown" } };
      await acknowledgeDeviceSave(cfg, flow);
      unlinkSync(path);
      return { result: { phase: "connected", binding, ...(state.request_id ? { request_id: state.request_id } : {}) } };
    });
    if (result.result.phase !== "pending" || result.result.handle !== handle ||
      !result.wait || Date.now() + result.wait >= deadline) return result.result;
    await sleep(result.wait);
  }
}

async function exchange(cfg: HubOAuthConfig, flow: Flow): Promise<ConnectResult | "slow_down" | "authorization_pending" | "exchange_unknown"> {
  try {
    const response = await fetch(cfg.tokenURL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: cfg.clientID, resource: cfg.resource, device_code: flow.device_code }),
    });
    const data = await response.json() as { error?: string; access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string };
    if (response.status === 400 && (data.error === "slow_down" || data.error === "authorization_pending")) return data.error;
    if (response.ok && typeof data.token_type === "string" && data.token_type.toLowerCase() === "bearer" &&
      (data.refresh_token === undefined || (typeof data.refresh_token === "string" && data.refresh_token)) && typeof data.access_token === "string" && data.access_token &&
      typeof data.expires_in === "number" && Number.isSafeInteger(data.expires_in) && data.expires_in > 0) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
    }
  } catch { /* exchange outcome may be unknown */ }
  return "exchange_unknown";
}
