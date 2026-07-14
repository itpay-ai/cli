import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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

interface DeviceState {
  schemaVersion: "itpay.device.v1";
  deviceID: string;
  deviceKeyID: string;
  quotaLineageID: string;
  agentInstances: Record<string, string>;
  sessions: Record<string, DeviceSessionState>;
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
  private readonly requestedAgentType: string | undefined;
  private readonly compatibilityHeaders: Record<string, string>;
  private readonly statePath: string;
  private readonly privateKeyPath: string;
  private readonly fetchImpl: typeof fetch;
  private pending: Promise<{ state: DeviceState; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> | undefined;

  constructor(options: DeviceAuthorityOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, "");
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

  private async ensureAuthorization(): Promise<{ state: DeviceState; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> {
    if (!this.pending) {
      this.pending = withFileLock(`${this.statePath}.lock`, () => this.prepareAuthorization()).finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async prepareAuthorization(): Promise<{ state: DeviceState; agentType: string; session: DeviceSessionState; privateKey: KeyObject }> {
    let state = this.readState();
    const agentType = this.requestedAgentType ?? firstAgentType(state);
    if (!agentType) {
      throw new Error("agent type is required for ItPay commerce; pass --agent-type <type> or set ITPAY_AGENT_TYPE");
    }
    let privateKey = this.readPrivateKey();
    if (!state || !privateKey) {
      const enrolled = await this.enroll(agentType);
      state = enrolled.state;
      privateKey = enrolled.privateKey;
    }
    if (!state.agentInstances[agentType]) {
      const existingType = firstAgentType(state);
      if (!existingType) throw new Error("device has no registered agent instance");
      const existingSession = await this.ensureSession(state, existingType, privateKey);
      const registered = await this.signedJSON<{ agent_instance_id: string }>(
        "/v1/agent-instances",
        { agent_type: agentType },
        state,
        existingType,
        existingSession,
        privateKey,
      );
      state.agentInstances[agentType] = registered.agent_instance_id;
      this.writeState(state);
    }
    const session = await this.ensureSession(state, agentType, privateKey);
    return { state, agentType, session, privateKey };
  }

  private async enroll(agentType: string): Promise<{ state: DeviceState; privateKey: KeyObject }> {
    const pair = generateKeyPairSync("ed25519");
    const publicJWK = pair.publicKey.export({ format: "jwk" });
    if (!publicJWK.x) throw new Error("unable to export Ed25519 public key");
    const publicKey = Buffer.from(publicJWK.x, "base64url").toString("base64");
    const started = await this.publicJSON<EnrollmentStarted>("/v1/agent-device-enrollments", { public_key: publicKey, agent_type: agentType });
    const proof = enrollmentProofMessage(started.agent_device_enrollment_id, started.challenge);
    const verified = await this.publicJSON<EnrollmentVerified>(
      `/v1/agent-device-enrollments/${encodeURIComponent(started.agent_device_enrollment_id)}/verify`,
      { challenge: started.challenge, signature: sign(null, Buffer.from(proof), pair.privateKey).toString("base64") },
    );
    const state: DeviceState = {
      schemaVersion: "itpay.device.v1",
      deviceID: verified.agent_device_id,
      deviceKeyID: verified.agent_device_key_id,
      quotaLineageID: verified.quota_lineage_id,
      agentInstances: { [verified.agent_type]: verified.agent_instance_id },
      sessions: {},
    };
    this.writePrivateKey(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    this.writeState(state);
    return { state, privateKey: pair.privateKey };
  }

  private async ensureSession(state: DeviceState, agentType: string, privateKey: KeyObject): Promise<DeviceSessionState> {
    const existing = state.sessions[agentType];
    if (existing && Date.parse(existing.expiresAt) > Date.now() + 60_000) return existing;
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
    this.writeState(state);
    return session;
  }

  private async signedJSON<T>(path: string, bodyValue: unknown, state: DeviceState, agentType: string, session: DeviceSessionState, privateKey: KeyObject): Promise<T> {
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
    if (!response.ok) throw new Error(payload.message || payload.code || `ItPay device request failed: ${response.status}`);
    return payload as T;
  }

  private readState(): DeviceState | undefined {
    if (!existsSync(this.statePath)) return undefined;
    try { return JSON.parse(readFileSync(this.statePath, "utf8")) as DeviceState; } catch { return undefined; }
  }

  private readPrivateKey(): KeyObject | undefined {
    if (!existsSync(this.privateKeyPath)) return undefined;
    try { return createPrivateKey(readFileSync(this.privateKeyPath, "utf8")); } catch { return undefined; }
  }

  private writeState(state: DeviceState): void { atomicOwnerOnlyWrite(this.statePath, JSON.stringify(state, null, 2)); }
  private writePrivateKey(value: string): void { atomicOwnerOnlyWrite(this.privateKeyPath, value); }
}

function firstAgentType(state: DeviceState | undefined): string | undefined { return state ? Object.keys(state.agentInstances)[0] : undefined; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function enrollmentProofMessage(id: string, challenge: string): string { return `itpay-device-enrollment/v1\n${id}\n${challenge}`; }
function deviceSessionProofMessage(id: string, challenge: string): string { return `itpay-device-session/v1\n${id}\n${challenge}`; }
function requestProofMessage(method: string, path: string, bodyHash: string, timestamp: string, jti: string): string { return ["itpay-agent-request/v1", method, path, bodyHash, timestamp, jti].join("\n"); }

function atomicOwnerOnlyWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (descriptor === undefined) throw new Error("timed out waiting for ItPay device identity lock");
  try {
    return await run();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
