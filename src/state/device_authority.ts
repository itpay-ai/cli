import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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

interface DeviceStateV1 extends DeviceRegistration {
  schemaVersion: "itpay.device.v1";
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

const PROTECTED_PATHS = ["/v1/carts", "/v1/service-executions", "/v1/agent-instances", "/v1/orders", "/v1/refunds"];

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
    const root = resolve(homedir(), ".itpay-v3", "device");
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
      this.pending = withFileLock(`${this.statePath}.lock`, () => this.prepareAuthorization()).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  async recoverAuthorization(): Promise<void> {
    await withFileLock(`${this.statePath}.lock`, async () => {
      const state = this.readState();
      if (!state || !this.requestedAgentType) return;
      const registration = state.registrations[this.backendKey];
      if (!registration) return;
      delete registration.sessions[this.requestedAgentType];
      this.writeState(state);
    });
  }

  async recoverBackendReset(): Promise<{ removed: boolean; agentTypes: string[] }> {
    return withFileLock(`${this.statePath}.lock`, async () => {
      const state = this.readState();
      const registration = state?.registrations[this.backendKey];
      if (!state || !registration) return { removed: false, agentTypes: [] };
      const agentTypes = Object.keys(registration.agentInstances).sort();
      delete state.registrations[this.backendKey];
      this.writeState(state);
      return { removed: true, agentTypes };
    });
  }

  private async prepareAuthorization(): Promise<{ state: DeviceRegistration; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> {
    let state = this.readState() ?? emptyDeviceState();
    const agentType = this.requestedAgentType;
    if (!agentType) {
      throw new Error("agent type is required for ItPay commerce; pass --agent-type <type> or set ITPAY_AGENT_TYPE");
    }
    let privateKey = this.readPrivateKey();
    if (!privateKey) {
      const pair = generateKeyPairSync("ed25519");
      privateKey = pair.privateKey;
      this.writePrivateKey(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
      state = emptyDeviceState();
    }

    let registration = state.registrations[this.backendKey];
    if (!registration && state.legacyRegistration) {
      try {
        await this.ensureRegistrationAgentType(state.legacyRegistration, agentType, privateKey, true);
        registration = state.legacyRegistration;
        delete state.legacyRegistration;
      } catch (error) {
        if (!canMovePastLegacyRegistration(error)) throw error;
      }
    }
    if (!registration) {
      registration = await this.enroll(agentType, privateKey);
    }
    state.registrations[this.backendKey] = registration;
    const session = await this.ensureRegistrationAgentType(registration, agentType, privateKey, false);
    this.writeState(state);
    return { state: registration, agentType, session, privateKey };
  }

  private async ensureRegistrationAgentType(
    registration: DeviceRegistration,
    agentType: string,
    privateKey: KeyObject,
    forceSession: boolean,
  ): Promise<DeviceSessionState> {
    if (!registration.agentInstances[agentType]) {
      const existingType = firstAgentType(registration);
      if (!existingType) throw new Error("device has no registered agent instance");
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
    }
    return this.ensureSession(registration, agentType, privateKey, forceSession);
  }

  private async enroll(agentType: string, privateKey: KeyObject): Promise<DeviceRegistration> {
    const publicJWK = createPublicKey(privateKey).export({ format: "jwk" });
    if (!publicJWK.x) throw new Error("unable to export Ed25519 public key");
    const publicKey = Buffer.from(publicJWK.x, "base64url").toString("base64");
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
    const response = await this.fetchImpl(this.baseURL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...this.compatibilityHeaders, ...extraHeaders },
      body,
    });
    const payload = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (!response.ok) throw new DeviceAuthorizationError(response.status, payload.code, payload.message || payload.code || `ItPay device request failed: ${response.status}`);
    return payload as T;
  }

  private readState(): DeviceState | undefined {
    if (!existsSync(this.statePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as DeviceState | DeviceStateV1;
      if (parsed.schemaVersion === "itpay.device.v2") return parsed;
      if (parsed.schemaVersion === "itpay.device.v1") {
        const { schemaVersion: _, ...legacyRegistration } = parsed;
        return { ...emptyDeviceState(), legacyRegistration };
      }
      return undefined;
    } catch (error) {
      const stateError = asDeviceStateError(error, "read_state");
      if (stateError) throw stateError;
      return undefined;
    }
  }

  private readPrivateKey(): KeyObject | undefined {
    if (!existsSync(this.privateKeyPath)) return undefined;
    try {
      return createPrivateKey(readFileSync(this.privateKeyPath, "utf8"));
    } catch (error) {
      const stateError = asDeviceStateError(error, "read_private_key");
      if (stateError) throw stateError;
      return undefined;
    }
  }

  private writeState(state: DeviceState): void { atomicOwnerOnlyWrite(this.statePath, JSON.stringify(state, null, 2), "write_state"); }
  private writePrivateKey(value: string): void { atomicOwnerOnlyWrite(this.privateKeyPath, value, "write_private_key"); }
}

export class DeviceAuthorizationError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "DeviceAuthorizationError";
  }
}

export class DeviceStateError extends Error {
  readonly code = "device_state_unwritable";

  constructor(readonly operation: DeviceStateOperation, readonly causeCode: string) {
    super(`ItPay device state operation failed: ${operation} (${causeCode})`);
    this.name = "DeviceStateError";
  }
}

type DeviceStateOperation =
  | "read_state"
  | "read_private_key"
  | "write_state"
  | "write_private_key"
  | "prepare_lock"
  | "acquire_lock"
  | "inspect_lock"
  | "remove_stale_lock"
  | "release_lock";

function emptyDeviceState(): DeviceState {
  return { schemaVersion: "itpay.device.v2", registrations: {} };
}

function firstAgentType(state: DeviceRegistration): string | undefined { return Object.keys(state.agentInstances)[0]; }
function canMovePastLegacyRegistration(error: unknown): boolean {
  return error instanceof DeviceAuthorizationError && (error.code === "agent_device_revoked" || error.status === 404);
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

function atomicOwnerOnlyWrite(path: string, value: string, operation: DeviceStateOperation): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw asDeviceStatePathError(error, operation) ?? error;
  }
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw asDeviceStatePathError(error, "prepare_lock") ?? error;
  }
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw asDeviceStateError(error, "acquire_lock") ?? error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) removeLock(path, "remove_stale_lock");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw asDeviceStateError(statError, "inspect_lock") ?? statError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!acquired) throw new Error("timed out waiting for ItPay device identity lock");
  try {
    return await run();
  } finally {
    removeLock(path, "release_lock");
  }
}

function removeLock(path: string, operation: DeviceStateOperation): void {
  try {
    if (statSync(path).isDirectory()) rmdirSync(path);
    else unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw asDeviceStateError(error, operation) ?? error;
  }
}

function asDeviceStateError(error: unknown, operation: DeviceStateOperation): DeviceStateError | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOTDIR" || code === "EISDIR"
    ? new DeviceStateError(operation, code)
    : undefined;
}

function asDeviceStatePathError(error: unknown, operation: DeviceStateOperation): DeviceStateError | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" ? new DeviceStateError(operation, code) : asDeviceStateError(error, operation);
}
