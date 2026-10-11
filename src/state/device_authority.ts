import { asTransientTransportError } from "../client/transport.js";
import { createDeviceKey, deviceKeyThumbprint, readDeviceKey } from "./device_key.js";
import { deviceCacheAgentTypes, DeviceSessionCache } from "./device_session_cache.js";
import {
  createHash,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  constants,
  closeSync,
  openSync,
  fstatSync,
  lstatSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

interface DeviceAuthorityOptions {
  baseURL: string;
  requestedAgentType?: string;
  compatibilityHeaders: Record<string, string>;
  statePath?: string;
  privateKeyPath?: string;
  fetchImpl?: typeof fetch;
}

interface DeviceSessionState {
  token: string;
  expiresAt: string;
}

interface DeviceRegistration {
  deviceID: string;
  deviceKeyID: string;
  quotaLineageID: string;
  agentInstances: Record<string, string>;
  sessions: Record<string, DeviceSessionState>;
}

interface DeviceState {
  schemaVersion: "itpay.device.v2";
  registrations: Record<string, DeviceRegistration>;
  legacyRegistration?: DeviceRegistration;
}

interface EnrollmentStarted {
  agent_device_enrollment_id: string;
  challenge: string;
}

interface EnrollmentVerified {
  agent_device_id: string;
  agent_device_key_id: string;
  quota_lineage_id: string;
  agent_instance_id: string;
  agent_type: string;
}

interface SessionChallenge {
  agent_device_session_challenge_id: string;
  challenge: string;
}

interface SessionVerified {
  session_token: string;
  expires_at: string;
}

const PROTECTED_PATHS = ["/v1/agent-device-account-bindings", "/v1/carts", "/v1/service-executions", "/v1/agent-instances", "/v1/orders", "/v1/refunds", "/v1/me", "/v1/vault", "/v1/rail/phone-links", "/v1/rail-aftercare"];

export class DeviceAuthority {
  private readonly baseURL: string;
  private readonly backendKey: string;
  private readonly requestedAgentType: string | undefined;
  private readonly compatibilityHeaders: Record<string, string>;
  private readonly statePath: string;
  private readonly privateKeyPath: string;
  private readonly fetchImpl: typeof fetch;
  private pending: Promise<{ state: DeviceRegistration; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> | undefined;

  constructor(options: DeviceAuthorityOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, "");
    this.backendKey = normalizeBackendKey(options.baseURL);
    this.requestedAgentType = options.requestedAgentType;
    this.compatibilityHeaders = options.compatibilityHeaders;
    const root = resolve(stateDir(), "device");
    this.statePath = options.statePath ?? resolve(root, "identity.json");
    this.privateKeyPath = options.privateKeyPath ?? resolve(root, "device-private.pem");
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async authorizationHeaders(input: { method: string; path: string; body: string }): Promise<Record<string, string>> {
    if (!PROTECTED_PATHS.some((prefix) => input.path.startsWith(prefix))) return {};
    const auth = await this.ensureAuthorization();
    const timestamp = new Date().toISOString();
    const jti = randomUUID();
    const bodyHash = sha256(input.body);
    const message = requestProofMessage(input.method, input.path, bodyHash, timestamp, jti);
    const signature = sign(null, Buffer.from(message), auth.privateKey).toString("base64");
    return {
      Authorization: `ItPayDevice ${auth.session.token}`,
      "X-ItPay-Agent-Instance-ID": auth.state.agentInstances[auth.agentType] ?? "",
      "X-ItPay-Agent-Type": auth.agentType,
      "X-ItPay-Agent-Timestamp": timestamp,
      "X-ItPay-Agent-Proof-JTI": jti,
      "X-ItPay-Agent-Body-SHA256": bodyHash,
      "X-ItPay-Agent-Signature": signature,
    };
  }

  private async ensureAuthorization(): Promise<{ state: DeviceRegistration; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> {
    if (!this.pending) {
      this.pending = this.cachedAuthorization() ?? this.prepareAuthorization();
      this.pending = this.pending.finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private cache(privateKey: KeyObject, agentType = this.requestedAgentType): DeviceSessionCache {
    if (!agentType) throw new Error("agent type is required for ItPay commerce; pass --agent-type <type> or set ITPAY_AGENT_TYPE");
    return new DeviceSessionCache(resolve(dirname(this.statePath), "sessions"), {
      backend: this.backendKey, agentType, keyThumbprint: deviceKeyThumbprint(privateKey),
    });
  }

  private cachedAuthorization(): Promise<{ state: DeviceRegistration; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> | undefined {
    const agentType = this.requestedAgentType;
    if (!agentType) return undefined;
    this.readState(); // Unknown/corrupt legacy identity never becomes a fresh device.
    const privateKey = this.readPrivateKey();
    if (!privateKey) return undefined;
    try {
      const registration = this.cache(privateKey).read();
      const session = registration?.sessions[agentType];
      if (!registration || !session || Date.parse(session.expiresAt) <= Date.now() + 60_000) return undefined;
      return Promise.resolve({ state: registration, agentType, session, privateKey });
    } catch (error) { throw asDeviceStateError(error, "read_state"); }
  }

  async recoverAuthorization(): Promise<void> {
    const privateKey = this.readPrivateKey();
    if (!privateKey || !this.requestedAgentType) return;
    try { this.cache(privateKey).invalidate(); } catch (error) { throw asDeviceStateError(error, "write_state"); }
  }

  repairLock(): "unmanaged" { return "unmanaged"; }

  async recoverBackendReset(): Promise<{ removed: boolean; agentTypes: string[] }> {
    const privateKey = this.readPrivateKey();
    if (!privateKey) return { removed: false, agentTypes: [] };
    try {
      const types = deviceCacheAgentTypes(resolve(dirname(this.statePath), "sessions"), this.backendKey, deviceKeyThumbprint(privateKey));
      if (this.requestedAgentType && !types.includes(this.requestedAgentType)) types.push(this.requestedAgentType);
      for (const type of types) this.cache(privateKey, type).invalidate();
      return { removed: types.length > 0, agentTypes: types.sort() };
    } catch (error) { throw asDeviceStateError(error, "write_state"); }
  }

  async resetDeviceKey(): Promise<{ removedBackends: string[] }> {
    throw Object.assign(new Error("Device key reset is unavailable in this version; the original identity is unchanged"), { code: "device_key_reset_unavailable" });
  }

  private async prepareAuthorization(): Promise<{ state: DeviceRegistration; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> {
    const state = this.readState();
    const agentType = this.requestedAgentType;
    if (!agentType) throw new Error("agent type is required for ItPay commerce; pass --agent-type <type> or set ITPAY_AGENT_TYPE");
    let privateKey: KeyObject;
    try {
      const cacheDirectory = resolve(dirname(this.statePath), "sessions");
      const hasCache = existsSync(cacheDirectory) && readdirSync(cacheDirectory).some(name => /\.(json|generation)$/.test(name));
      privateKey = createDeviceKey(this.privateKeyPath, state !== undefined || hasCache);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      throw asDeviceStateError(error, typeof code === "string" && code.startsWith("DEVICE_KEY_") ? "read_private_key" : "write_private_key");
    }
    const cache = this.cache(privateKey);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let generation: string;
      let registration: DeviceRegistration | undefined;
      try {
        generation = cache.generation(true)!;
        registration = cache.read() ?? cache.registrationHint();
      } catch (error) { throw asDeviceStateError(error, "read_state"); }
      // The old file is a registration hint only, never a session fallback.
      if (!registration) {
        const hint = state?.registrations[this.backendKey];
        if (hint?.agentInstances[agentType]) registration = { ...hint, agentInstances: { ...hint.agentInstances }, sessions: {} };
      }
      if (!registration) registration = await this.enroll(agentType, privateKey);
      let session: DeviceSessionState;
      try { session = await this.ensureRegistrationAgentType(registration, agentType, privateKey, false); }
      catch (error) {
        if (!isUnknownDeviceRegistration(error)) throw error;
        registration = await this.enroll(agentType, privateKey);
        session = await this.ensureRegistrationAgentType(registration, agentType, privateKey, false);
      }
      try {
        cache.write(registration, generation);
        if (cache.generation(false) !== generation) continue;
      } catch (error) { throw asDeviceStateError(error, "write_state"); }
      return { state: registration, agentType, session, privateKey };
    }
    throw new DeviceStateError("write_state", "DEVICE_CACHE_BUSY");
  }

  private async ensureRegistrationAgentType(
    registration: DeviceRegistration,
    agentType: string,
    privateKey: KeyObject,
    forceSession: boolean,
  ): Promise<DeviceSessionState> {
    if (!registration.agentInstances[agentType]) {
      const existingTypes = Object.keys(registration.agentInstances).sort();
      if (existingTypes.length === 0) throw new Error("device has no registered agent instance");
      let revokedError: DeviceAuthorizationError | undefined;
      for (const existingType of existingTypes) {
        try {
          const existingSession = await this.ensureSession(registration, existingType, privateKey, forceSession);
          const registered = await this.signedJSON<{ agent_instance_id: string }>(
            "/v1/agent-instances",
            { agent_type: agentType },
            registration,
            existingType,
            existingSession,
            privateKey,
          );
          registration.agentInstances[agentType] = registered.agent_instance_id;
          break;
        } catch (error) {
          if (!(error instanceof DeviceAuthorizationError) || error.code !== "agent_device_revoked") throw error;
          delete registration.sessions[existingType];
          revokedError = error;
        }
      }
      if (!registration.agentInstances[agentType]) throw revokedError ?? new Error("device has no active registered agent instance");
    }
    return this.ensureSession(registration, agentType, privateKey, forceSession);
  }

  private async enroll(agentType: string, privateKey: KeyObject): Promise<DeviceRegistration> {
    const publicJWK = createPublicKey(privateKey).export({ format: "jwk" });
    if (!publicJWK.x) throw new Error("unable to export Ed25519 public key");
    const publicKey = Buffer.from(publicJWK.x, "base64url").toString("base64");
    try {
      const started = await this.publicJSON<EnrollmentStarted>("/v1/agent-device-enrollments", { public_key: publicKey, agent_type: agentType });
      const proof = enrollmentProofMessage(started.agent_device_enrollment_id, started.challenge);
      const verified = await this.publicJSON<EnrollmentVerified>(
        `/v1/agent-device-enrollments/${encodeURIComponent(started.agent_device_enrollment_id)}/verify`,
        { challenge: started.challenge, signature: sign(null, Buffer.from(proof), privateKey).toString("base64") },
      );
      return {
        deviceID: verified.agent_device_id,
        deviceKeyID: verified.agent_device_key_id,
        quotaLineageID: verified.quota_lineage_id,
        agentInstances: { [verified.agent_type]: verified.agent_instance_id },
        sessions: {},
      };
    } catch (error) {
      if (error instanceof DeviceAuthorizationError) error.enrollmentFailed = true;
      throw error;
    }
  }

  private async ensureSession(state: DeviceRegistration, agentType: string, privateKey: KeyObject, force = false): Promise<DeviceSessionState> {
    const existing = state.sessions[agentType];
    if (!force && existing && Date.parse(existing.expiresAt) > Date.now() + 60_000) return existing;
    const instanceID = state.agentInstances[agentType];
    if (!instanceID) throw new Error(`agent instance is not registered for ${agentType}`);
    const challenge = await this.publicJSON<SessionChallenge>("/v1/agent-device-session-challenges", {
      agent_device_id: state.deviceID,
      agent_instance_id: instanceID,
    });
    const proof = deviceSessionProofMessage(challenge.agent_device_session_challenge_id, challenge.challenge);
    const verified = await this.publicJSON<SessionVerified>(
      `/v1/agent-device-session-challenges/${encodeURIComponent(challenge.agent_device_session_challenge_id)}/verify`,
      { challenge: challenge.challenge, signature: sign(null, Buffer.from(proof), privateKey).toString("base64") },
    );
    const session = { token: verified.session_token, expiresAt: verified.expires_at };
    state.sessions[agentType] = session;
    return session;
  }

  private async signedJSON<T>(path: string, bodyValue: unknown, state: DeviceRegistration, agentType: string, session: DeviceSessionState, privateKey: KeyObject): Promise<T> {
    const body = JSON.stringify(bodyValue);
    const timestamp = new Date().toISOString();
    const jti = randomUUID();
    const bodyHash = sha256(body);
    const signature = sign(null, Buffer.from(requestProofMessage("POST", path, bodyHash, timestamp, jti)), privateKey).toString("base64");
    return this.fetchJSON<T>(path, body, {
      Authorization: `ItPayDevice ${session.token}`,
      "X-ItPay-Agent-Instance-ID": state.agentInstances[agentType] ?? "",
      "X-ItPay-Agent-Type": agentType,
      "X-ItPay-Agent-Timestamp": timestamp,
      "X-ItPay-Agent-Proof-JTI": jti,
      "X-ItPay-Agent-Body-SHA256": bodyHash,
      "X-ItPay-Agent-Signature": signature,
    });
  }

  private publicJSON<T>(path: string, bodyValue: unknown): Promise<T> {
    return this.fetchJSON<T>(path, JSON.stringify(bodyValue), {});
  }

  private async fetchJSON<T>(path: string, body: string, extraHeaders: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseURL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...this.compatibilityHeaders, ...extraHeaders },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    } catch (error) { throw asTransientTransportError(error, 1) ?? error; }
    const payload = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (!response.ok) throw new DeviceAuthorizationError(response.status, payload.code, payload.message || payload.code || `ItPay device request failed: ${response.status}`);
    return payload as T;
  }

  private readState(): DeviceState | undefined {
    try {
      let stat;
      try { stat = lstatSync(this.statePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new DeviceStateError("read_state", "DEVICE_STATE_INVALID_FILE");
      const fd = openSync(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let parsed: unknown;
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new DeviceStateError("read_state", "DEVICE_STATE_CHANGED");
        try { parsed = JSON.parse(readFileSync(fd, "utf8")); }
        catch { throw new DeviceStateError("read_state", "DEVICE_STATE_CORRUPT"); }
      } finally { closeSync(fd); }
      if (!isRecord(parsed)) throw new DeviceStateError("read_state", "DEVICE_STATE_CORRUPT");
      if (parsed.schemaVersion === "itpay.device.v2") {
        if (!isRecord(parsed.registrations) || !Object.values(parsed.registrations).every(isDeviceRegistration) || (parsed.legacyRegistration !== undefined && !isDeviceRegistration(parsed.legacyRegistration))) throw new DeviceStateError("read_state", "DEVICE_STATE_CORRUPT");
        const registrations: Record<string, DeviceRegistration> = {};
        for (const [backend, value] of Object.entries(parsed.registrations)) {
          if (!isDeviceRegistration(value)) throw new DeviceStateError("read_state", "DEVICE_STATE_CORRUPT");
          registrations[backend] = value;
        }
        return { schemaVersion: "itpay.device.v2", registrations, ...(parsed.legacyRegistration ? { legacyRegistration: parsed.legacyRegistration } : {}) };
      }
      if (parsed.schemaVersion === "itpay.device.v1") {
        if (!isDeviceRegistration(parsed)) throw new DeviceStateError("read_state", "DEVICE_STATE_CORRUPT");
        return { ...emptyDeviceState(), legacyRegistration: parsed };
      }
      throw new DeviceStateError("read_state", "DEVICE_STATE_SCHEMA_INVALID");
    } catch (error) { throw asDeviceStateError(error, "read_state"); }
  }

  private readPrivateKey(): KeyObject | undefined {
    try { return readDeviceKey(this.privateKeyPath); }
    catch (error) { throw asDeviceStateError(error, "read_private_key"); }
  }


}

export class DeviceAuthorizationError extends Error {
  enrollmentFailed = false;

  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "DeviceAuthorizationError";
  }
}

export class DeviceStateError extends Error {
  readonly code = "device_state_unavailable";
  readonly source: "native_filesystem" | "host_broker" | "client_state_validation" | "unclassified_local_operation";

  constructor(readonly operation: DeviceStateOperation, readonly causeCode: string, readonly blockedPath?: string, readonly canonicalKeyPublished?: boolean) {
    super(`ItPay device state operation failed: ${operation} (${causeCode})`);
    this.name = "DeviceStateError";
    this.source = causeCode === "UNCLASSIFIED_LOCAL_FAILURE" ? "unclassified_local_operation" : causeCode.startsWith("CODEBUDDY_BROKER_") ? "host_broker"
      : /^DEVICE_(KEY|CACHE|STATE)_/.test(causeCode) ? "client_state_validation" : "native_filesystem";
  }
}

export type DeviceStateOperation =
  | "read_state"
  | "read_private_key"
  | "write_state"
  | "cleanup_private_key_temporary"
  | "write_private_key";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isDeviceRegistration(value: unknown): value is DeviceRegistration {
  return isRecord(value) && typeof value.deviceID === "string" && typeof value.deviceKeyID === "string" && typeof value.quotaLineageID === "string"
    && isRecord(value.agentInstances) && Object.values(value.agentInstances).every(id => typeof id === "string")
    && isRecord(value.sessions) && Object.values(value.sessions).every(session => isRecord(session) && typeof session.token === "string" && typeof session.expiresAt === "string" && Number.isFinite(Date.parse(session.expiresAt)));
}

function emptyDeviceState(): DeviceState {
  return { schemaVersion: "itpay.device.v2", registrations: {} };
}

function isUnknownDeviceRegistration(error: unknown): boolean {
  return error instanceof DeviceAuthorizationError && (error.code === "agent_device_not_found" || error.status === 404);
}
function normalizeBackendKey(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function enrollmentProofMessage(id: string, challenge: string): string { return `itpay-device-enrollment/v1\n${id}\n${challenge}`; }
function deviceSessionProofMessage(id: string, challenge: string): string { return `itpay-device-session/v1\n${id}\n${challenge}`; }
function requestProofMessage(method: string, path: string, bodyHash: string, timestamp: string, jti: string): string { return ["itpay-agent-request/v1", method, path, bodyHash, timestamp, jti].join("\n"); }

export function asDeviceStateError(error: unknown, operation: DeviceStateOperation): DeviceStateError {
  if (error instanceof DeviceStateError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const known = ["EACCES", "EPERM", "EROFS", "ENOTDIR", "EISDIR", "EEXIST", "ENOENT", "ENOTEMPTY", "ENOSPC", "EMFILE", "EIO", "CODEBUDDY_BROKER_DENY", "CODEBUDDY_BROKER_OUTCOME_UNKNOWN"];
  const cleanup = isRecord(error) && error.deviceStateOperation === "cleanup_private_key_temporary";
  return new DeviceStateError(cleanup ? "cleanup_private_key_temporary" : operation, typeof code === "string" && (known.includes(code) || /^DEVICE_(KEY|CACHE|STATE)_[A-Z_]+$/.test(code)) ? code : "UNCLASSIFIED_LOCAL_FAILURE", undefined, cleanup && typeof error.canonicalKeyPublished === "boolean" ? error.canonicalKeyPublished : undefined);
}

import { stateDir } from "./config.js";
