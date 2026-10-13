import assert from "node:assert/strict";
import { createPublicKey, verify, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { DeviceSessionCache } from "../src/state/device_session_cache.js";
import { readDeviceKey, deviceKeyThumbprint, createDeviceKey } from "../src/state/device_key.js";
import { HttpClient, HttpError } from "../src/client/http.js";
import { DeviceAuthority, DeviceAuthorizationError, DeviceStateError } from "../src/state/device_authority.js";

test("legacy empty identity without its key remains an unsupported recovery state", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-empty-identity-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const original = JSON.stringify({ schemaVersion: "itpay.device.v2", registrations: {} });
  writeFileSync(statePath, original, { mode: 0o600 });
  const server = new DeviceServer();
  await assert.rejects(new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath,privateKeyPath,fetchImpl:server.fetch}).authorizationHeaders({method:"GET",path:"/v1/orders",body:""}), error => error instanceof DeviceStateError && error.causeCode === "DEVICE_KEY_MISSING");
  assert.equal(readFileSync(statePath,"utf8"),original);
  assert.equal(existsSync(privateKeyPath),false);
  assert.equal(server.requestCount,0);
});

test("device authority keeps one canonical key and device during concurrent enrollment and distinct agent caches", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-"));
  const statePath = join(root, "missing", "nested", "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai",
    requestedAgentType: "codex-cli",
    compatibilityHeaders: {},
    statePath,
    privateKeyPath,
    fetchImpl: server.fetch,
  };

  const [first, concurrent] = await Promise.all([
    new DeviceAuthority(options).authorizationHeaders({ method: "POST", path: "/v1/carts", body: "{}" }),
    new DeviceAuthority(options).authorizationHeaders({ method: "POST", path: "/v1/carts", body: "{}" }),
  ]);
  assert.equal(server.deviceCount, 1);
  assert.equal(first["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
  assert.equal(concurrent["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
  assert.equal(existsSync(statePath), false, "new cache must not write legacy identity");
  assert.equal(statSync(privateKeyPath).mode & 0o777, 0o600);
  assert.equal(existsSync(`${statePath}.lock`), false);
  assert.equal(readdirSync(join(statePath, "..")).some(name => name.startsWith("identity.json.lock.released.")), false);

  const requestCount = server.requestCount;
  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(server.requestCount, requestCount, "valid persisted session should not contact enrollment server");

  for (const path of ["/v1/orders/ord_1/refunds", "/v1/refunds/rr_1/cancel", "/v1/me/vault-artifacts", "/v1/vault/access-requests"]) {
    const headers = await new DeviceAuthority(options).authorizationHeaders({ method: "POST", path, body: "{}" });
    assert.match(headers.Authorization ?? "", /^ItPayDevice /);
  }

  const claude = await new DeviceAuthority({ ...options, requestedAgentType: "claude-code-cli" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(claude["X-ItPay-Agent-Instance-ID"], "ain_claude_code_cli");
  assert.equal(server.deviceCount, 1, "same public key must retain one device and lineage");
  assert.equal(server.enrollmentCount, 3, "two concurrent attaches and one distinct host attach are bounded");
  assert.equal(cached(options).agentInstances["codex-cli"], "ain_codex_cli");
  assert.equal(cached({...options,requestedAgentType:"claude-code-cli"}).agentInstances["claude-code-cli"], "ain_claude_code_cli");
});

test("device authority skips a revoked instance when registering a new agent type", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-revoked-instance-"));
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", compatibilityHeaders: {},
    statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
  };

  await new DeviceAuthority({ ...options, requestedAgentType: "codex-cli" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  await new DeviceAuthority({ ...options, requestedAgentType: "claude-code-cli" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  server.revokedAgentTypes.add("codex-cli");

  const headers = await new DeviceAuthority({ ...options, requestedAgentType: "workbuddy" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });

  assert.equal(headers["X-ItPay-Agent-Instance-ID"], "ain_workbuddy");
  assert.deepEqual(server.registrationAuthorizers, [], "new host proves its key directly; no revoked authorizer session is reused");
  assert.equal(server.deviceCount, 1, "a different host reattaches to the original device");
  assert.equal(server.enrollmentCount, 3);
});

test("device authority rejects the revoked requested instance without replacing its device", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-all-instances-revoked-"));
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", compatibilityHeaders: {},
    statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
  };

  await new DeviceAuthority({ ...options, requestedAgentType: "codex-cli" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  await new DeviceAuthority({ ...options, requestedAgentType: "claude-code-cli" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  const workbuddy = new DeviceAuthority({ ...options, requestedAgentType: "workbuddy" });
  await workbuddy.authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  await workbuddy.recoverAuthorization();
  server.revokedAgentTypes.add("workbuddy");
  server.revokedAgentTypes.add("codex-cli");
  server.revokedAgentTypes.add("claude-code-cli");

  await assert.rejects(
    () => new DeviceAuthority({ ...options, requestedAgentType: "workbuddy" })
      .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" }),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === "agent_device_revoked",
  );
  assert.equal(server.enrollmentCount, 3, "revoked requested instance must not enroll again");
  assert.equal(server.deviceCount, 1);
});

test("normal authorization preserves opaque legacy locks and all existing archives", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-lock-archive-collision-"));
  const statePath = join(root, "identity.json");
  const lockPath = `${statePath}.lock`;
  writeFileSync(lockPath, "99999999:deadbeef");
  mkdirSync(`${lockPath}.stale`);
  writeFileSync(`${lockPath}.stale/history`, "prior-stale");
  writeFileSync(`${lockPath}.released`, "prior-released");
  const server = new DeviceServer();
  await new DeviceAuthority({
    baseURL: "https://test.itpay.ai", requestedAgentType: "workbuddy", compatibilityHeaders: {},
    statePath, privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
  }).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(readFileSync(lockPath,"utf8"), "99999999:deadbeef");
  assert.equal(readFileSync(`${lockPath}.stale/history`, "utf8"), "prior-stale");
  assert.equal(readFileSync(`${lockPath}.released`, "utf8"), "prior-released");
  assert.equal(readdirSync(root).filter(name => name.startsWith("identity.json.lock.stale.")).length, 0);
  assert.equal(readdirSync(root).filter(name => name.startsWith("identity.json.lock.released.")).length, 0);
  assert.equal(server.enrollmentCount, 1);
});

test("device authority returns a stable error when its state path is not writable", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-unwritable-"));
  await assert.rejects(
    () => new DeviceAuthority({
      baseURL: "https://test.itpay.ai", requestedAgentType: "workbuddy", compatibilityHeaders: {},
      statePath: "/dev/null/identity.json", privateKeyPath: join(root, "private.pem"), fetchImpl: new DeviceServer().fetch,
    }).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" }),
    (error: unknown) => error instanceof DeviceStateError &&
      error.code === "device_state_unavailable" &&
      error.operation === "read_state" && error.causeCode === "ENOTDIR",
  );
});

test("device authority keeps one private key and separate registrations per backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-backends-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const testServer = new DeviceServer();
  const devServer = new DeviceServer();
  const fetchImpl: typeof fetch = (input, init) =>
    new URL(String(input)).hostname === "dev.itpay.ai" ? devServer.fetch(input, init) : testServer.fetch(input, init);

  for (const baseURL of ["https://test.itpay.ai/", "https://dev.itpay.ai"]) {
    await new DeviceAuthority({ baseURL, requestedAgentType: "codex-desktop", compatibilityHeaders: {}, statePath, privateKeyPath, fetchImpl })
      .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  }

  const production = {baseURL:"https://test.itpay.ai",requestedAgentType:"codex-desktop",statePath,privateKeyPath};
  const development = {...production,baseURL:"https://dev.itpay.ai"};
  assert.equal(cached(production).deviceID,"adev_1");
  assert.equal(cached(development).deviceID,"adev_1");
  assert.equal(readdirSync(join(root,"sessions")).filter(name=>name.endsWith(".json")).length,2);
  assert.equal(testServer.enrollmentCount,1);
  assert.equal(devServer.enrollmentCount,1);
  const privateKey = readFileSync(privateKeyPath,"utf8");
  const recovered = await new DeviceAuthority({...development,compatibilityHeaders:{},fetchImpl}).recoverBackendReset();
  assert.deepEqual(recovered,{removed:true,agentTypes:["codex-desktop"]});
  assert.equal(readFileSync(privateKeyPath,"utf8"),privateKey);
  const requests = testServer.requestCount;
  await new DeviceAuthority({...production,compatibilityHeaders:{},fetchImpl}).authorizationHeaders({method:"GET",path:"/v1/service-executions",body:""});
  assert.equal(testServer.requestCount,requests,"other Backend cache remains valid");
  assert.equal(existsSync(statePath),false,"old identity never created or rewritten");
});

test("device authority migrates a v1 registration only after the backend proves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-v1-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = { baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {}, statePath, privateKeyPath, fetchImpl: server.fetch };
  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  const registration = cached(options);
  writeFileSync(statePath, JSON.stringify({ schemaVersion: "itpay.device.v1", ...registration }), { mode: 0o600 });
  await new DeviceAuthority(options).recoverAuthorization();
  const before = readFileSync(statePath);
  const requestCount = server.requestCount;

  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });

  assert.deepEqual(readFileSync(statePath),before,"v1 remains read-only");
  assert.equal(cached(options).deviceID,registration.deviceID);
  assert.ok(server.requestCount > requestCount,"session is freshly proven to the selected Backend");
});

test("device authority does not attach a v1 registration to the wrong backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-v1-backend-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const testServer = new DeviceServer();
  const devServer = new DeviceServer();
  const fetchImpl: typeof fetch = (input, init) =>
    new URL(String(input)).hostname === "dev.itpay.ai" ? devServer.fetch(input, init) : testServer.fetch(input, init);
  const options = { requestedAgentType: "codex-cli", compatibilityHeaders: {}, statePath, privateKeyPath, fetchImpl };

  await new DeviceAuthority({ ...options, baseURL: "https://test.itpay.ai" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  writeFileSync(statePath, JSON.stringify({ schemaVersion: "itpay.device.v1", ...cached({...options,baseURL:"https://test.itpay.ai"}) }), { mode: 0o600 });
  const original = readFileSync(statePath);

  await new DeviceAuthority({ ...options, baseURL: "https://dev.itpay.ai" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(cached({...options,baseURL:"https://dev.itpay.ai"}).deviceID,"adev_1");
  assert.deepEqual(readFileSync(statePath),original);
  assert.equal(devServer.enrollmentCount,1);
  await new DeviceAuthority({...options,baseURL:"https://test.itpay.ai"}).authorizationHeaders({method:"GET",path:"/v1/service-executions",body:""});
  assert.deepEqual(readFileSync(statePath),original);
  assert.equal(testServer.enrollmentCount,1);
  assert.equal(readFileSync(privateKeyPath,"utf8").includes("PRIVATE KEY"),true);

});

test("device authority never replaces a revoked v2 registration automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-revoked-"));
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {},
    statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
  };
  const authority = new DeviceAuthority(options);
  await authority.authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  await authority.recoverAuthorization();
  server.revoked = true;

  await assert.rejects(
    () => new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" }),
    (error: unknown) => error instanceof DeviceAuthorizationError &&
      error.status === 403 && error.code === "agent_device_revoked" && error.message === "agent device is revoked",
  );
  assert.equal(server.enrollmentCount, 1, "revocation requires an explicit recovery flow");
});

test("HTTP retries one rejected device session with a fresh signed session", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-retry-"));
  const server = new DeviceServer();
  let protectedCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/service-executions") {
      protectedCalls += 1;
      return protectedCalls === 1
        ? json({ code: "agent_device_session_required", message: "agent device session is required" }, 401)
        : json({ executions: [] });
    }
    return server.fetch(input, init);
  };
  const authority = new DeviceAuthority({
    baseURL: "https://test.itpay.ai", requestedAgentType: "codex-desktop", compatibilityHeaders: {},
    statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl,
  });
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai", fetchImpl,
    requestAuthorizer: (input) => authority.authorizationHeaders(input),
    recoverAuthorization: () => authority.recoverAuthorization(),
  });

  assert.deepEqual(await client.get("/v1/service-executions"), { executions: [] });
  assert.equal(protectedCalls, 2);
  assert.equal(server.enrollmentCount, 1);
});

test("HTTP stops after one device session recovery attempt", async () => {
  let calls = 0;
  let recoveries = 0;
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    fetchImpl: async () => {
      calls += 1;
      return json({ code: "agent_device_session_required", message: "agent device session is required" }, 401);
    },
    recoverAuthorization: async () => { recoveries += 1; },
  });

  await assert.rejects(
    () => client.get("/v1/service-executions"),
    (error: unknown) => error instanceof HttpError && error.code === "agent_device_session_required",
  );
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
});

test("HTTP does not recover unrelated authentication failures", async () => {
  let recoveries = 0;
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    fetchImpl: async () => json({ code: "session_required", message: "buyer session is required" }, 401),
    recoverAuthorization: async () => { recoveries += 1; },
  });

  await assert.rejects(
    () => client.get("/v1/me/orders"),
    (error: unknown) => error instanceof HttpError && error.code === "session_required",
  );
  assert.equal(recoveries, 0);
});

class DeviceServer {
  enrollmentCount = 0;
  deviceCount = 0;
  private readonly thumbprints = new Set<string>();
  private readonly enrollmentTypes = new Map<string,string>();
  requestCount = 0;
  revoked = false;
  failEnrollmentVerify = false;
  readonly revokedAgentTypes = new Set<string>();
  readonly registrationAuthorizers: string[] = [];
  private publicKey: ReturnType<typeof createPublicKey> | undefined;
  private readonly instances = new Map<string, string>();
  private readonly devices = new Set<string>();

  forgetDevices(): void {
    this.devices.clear();
    this.instances.clear();
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requestCount += 1;
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (path === "/v1/agent-device-enrollments") {
      this.enrollmentCount += 1;
      const raw = Buffer.from(body.public_key!, "base64");
      this.publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
      const id = `enr_${this.enrollmentCount}`;
      this.enrollmentTypes.set(id, body.agent_type!);
      return json({ agent_device_enrollment_id: id, challenge: "enroll_nonce" });
    }
    if (path.startsWith("/v1/agent-device-enrollments/") && path.endsWith("/verify")) {
      const id = path.split("/").at(-2)!;
      this.assertSignature(`itpay-device-enrollment/v1\n${id}\nenroll_nonce`, body.signature!);
      if (this.failEnrollmentVerify) {
        return json({ code: "internal_error", message: "request failed" }, 500);
      }
      const type = this.enrollmentTypes.get(id)!;
      if (this.revoked || this.revokedAgentTypes.has(type)) return json({code:"agent_device_revoked",message:"agent device is revoked"},403);
      const thumbprint = createHash("sha256").update(this.publicKey!.export({format:"der",type:"spki"})).digest("hex");
      if (!this.thumbprints.has(thumbprint)) { this.thumbprints.add(thumbprint); this.deviceCount++; }
      const instance = `ain_${type.replaceAll("-", "_")}`;
      this.instances.set(type, instance);
      this.devices.add("adev_1");
      return json({ agent_device_id: "adev_1", agent_device_key_id: "akey_1", quota_lineage_id: "qln_1", agent_instance_id: instance, agent_type: type });
    }
    if (path === "/v1/agent-instances") {
      const authorization = String(new Headers(init?.headers).get("Authorization"));
      assert.match(authorization, /^ItPayDevice token_/);
      const authorizer = authorization.slice("ItPayDevice token_".length);
      this.registrationAuthorizers.push(authorizer);
      if (this.revoked || this.revokedAgentTypes.has(authorizer)) {
        return json({ code: "agent_device_revoked", message: "agent device or instance is revoked" }, 403);
      }
      const id = `ain_${body.agent_type!.replaceAll("-", "_")}`;
      this.instances.set(body.agent_type!, id);
      return json({ agent_instance_id: id });
    }
    if (path === "/v1/agent-device-session-challenges") {
      if (this.revoked) return json({ code: "agent_device_revoked", message: "agent device is revoked" }, 403);
      if (!this.devices.has(body.agent_device_id!)) return json({ code: "agent_device_not_found", message: "agent device registration is not present on this backend" }, 404);
      const agentType = [...this.instances].find(([, id]) => id === body.agent_instance_id)?.[0];
      if (!agentType) return json({ code: "agent_device_revoked", message: "agent device is not registered here" }, 403);
      if (this.revokedAgentTypes.has(agentType)) return json({ code: "agent_device_revoked", message: "agent instance is revoked" }, 403);
      return json({ agent_device_session_challenge_id: `ses_${agentType}`, challenge: `nonce_${agentType}` });
    }
    if (path.startsWith("/v1/agent-device-session-challenges/") && path.endsWith("/verify")) {
      const id = path.split("/").at(-2)!;
      const agentType = id.slice("ses_".length);
      this.assertSignature(`itpay-device-session/v1\n${id}\nnonce_${agentType}`, body.signature!);
      return json({ session_token: `token_${agentType}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return json({ code: "not_found", message: path }, 404);
  };

  private assertSignature(message: string, signature: string): void {
    assert.ok(this.publicKey);
    assert.equal(verify(null, Buffer.from(message), this.publicKey, Buffer.from(signature, "base64")), true);
  }
}

test("device authority re-enrolls an orphaned private key after interrupted first registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-orphan-key-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {},
    statePath, privateKeyPath, fetchImpl: server.fetch,
  };

  const first = await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  const firstInstance = first["X-ItPay-Agent-Instance-ID"];
  const privateKey = readFileSync(privateKeyPath, "utf8");

  // The server committed but a local cache is lost. Keep its generation and key.
  for (const name of readdirSync(join(root,"sessions")).filter(name=>name.endsWith(".json"))) fs.unlinkSync(join(root,"sessions",name));
  writeFileSync(statePath, JSON.stringify({ schemaVersion: "itpay.device.v2", registrations: {} }), { mode: 0o600 });

  const second = await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(second["X-ItPay-Agent-Instance-ID"], firstInstance, "re-enrollment with the same key re-attaches to the same instance");
  assert.equal(server.enrollmentCount, 2);
  assert.equal(readFileSync(privateKeyPath, "utf8"), privateKey, "the private key is preserved across re-attach");
});

test("device authority re-enrolls when the backend forgot the registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-forgotten-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {},
    statePath, privateKeyPath, fetchImpl: server.fetch,
  };

  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(server.enrollmentCount, 1);

  // Simulate a backend whose identity store was rebuilt: the registration rows
  // are gone, so session establishment reports agent_device_not_found.
  const key = readDeviceKey(privateKeyPath)!;
  const cache = new DeviceSessionCache(join(root,"sessions"),{backend:options.baseURL,agentType:options.requestedAgentType,keyThumbprint:deviceKeyThumbprint(key)});
  const state = cached(options);
  state.sessions[options.requestedAgentType]!.expiresAt = "1970-01-01T00:00:00Z";
  cache.write(state,cache.generation(false)!);
  server.forgetDevices();

  const second = await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(server.enrollmentCount, 2, "the stale registration is dropped and the device re-enrolls");
  assert.equal(second["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
});

test("device authority preserves the actual enrollment failure without resetting identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-enroll-fail-"));
  const server = new DeviceServer();
  server.failEnrollmentVerify = true;

  await assert.rejects(
    () => new DeviceAuthority({
      baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {},
      statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
    }).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" }),
    (error: unknown) => error instanceof DeviceAuthorizationError &&
      error.status === 500 && error.code === "internal_error" && error.enrollmentFailed === true,
  );
});

test("device key reset is unavailable and preserves key, cache and identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-reset-key-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = {
    baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {},
    statePath, privateKeyPath, fetchImpl: server.fetch,
  };
  const authority = new DeviceAuthority(options);
  await authority.authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  const previousKey = readFileSync(privateKeyPath, "utf8");

  const files = readdirSync(join(root,"sessions")).map(name=>[name,readFileSync(join(root,"sessions",name))] as const);
  await assert.rejects(authority.resetDeviceKey(),(error:unknown)=>!!error && typeof error==="object" && "code" in error && error.code==="device_key_reset_unavailable");
  assert.equal(readFileSync(privateKeyPath,"utf8"),previousKey);
  assert.equal(existsSync(statePath),false);
  for (const [name,bytes] of files) assert.deepEqual(readFileSync(join(root,"sessions",name)),bytes);
  const headers = await new DeviceAuthority(options).authorizationHeaders({method:"GET",path:"/v1/service-executions",body:""});
  assert.equal(headers["X-ItPay-Agent-Instance-ID"],"ain_codex_cli");
  assert.equal(server.enrollmentCount,1);

});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

for (const code of ["EACCES", "EPERM", "ENOTDIR", "EISDIR", "CODEBUDDY_BROKER_DENY", "CODEBUDDY_BROKER_OUTCOME_UNKNOWN", "UNKNOWN_TEST_CODE"]) {
  test(`key publication classifies ${code} at the file operation boundary`, async () => {
    const root = mkdtempSync(join(tmpdir(), "itpay-lock-error-"));
    const original = fs.writeFileSync;
    const patch = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("private diagnostic omitted"), { code });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(new DeviceAuthority({ baseURL: "https://test.itpay.ai", requestedAgentType: "workbuddy", compatibilityHeaders: {},
        statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: new DeviceServer().fetch,
      }).authorizationHeaders({ method: "GET", path: "/v1/orders", body: "" }), (error: unknown) => {
        assert.ok(error instanceof DeviceStateError);
        assert.equal(error.operation, "write_private_key");
        assert.equal(error.causeCode, code === "UNKNOWN_TEST_CODE" ? "UNCLASSIFIED_LOCAL_FAILURE" : code);
        assert.equal(error.source, code.startsWith("CODEBUDDY_") ? "host_broker" : code === "UNKNOWN_TEST_CODE" ? "unclassified_local_operation" : "native_filesystem");
        assert.doesNotMatch(error.message, /private diagnostic/);
        return true;
      });
    } finally { patch.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("authorization does not attempt legacy archive writes on enrollment failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-lock-release-error-"));
  const original = fs.renameSync;
  const patch = mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).includes(".released.")) throw Object.assign(new Error("release blocked"), { code: "EPERM" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(new DeviceAuthority({ baseURL: "https://test.itpay.ai", compatibilityHeaders: {},
      statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"),
      requestedAgentType: "workbuddy", fetchImpl: async () => Response.json({code:"agent_device_revoked",message:"revoked"}, {status:403}),
    }).authorizationHeaders({method:"GET",path:"/v1/orders",body:""}), (error: unknown) => error instanceof DeviceAuthorizationError && error.status === 403);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});


test("case-level aftercare requests carry device proof for read, respond and cancel", async () => {
 const root=mkdtempSync(join(tmpdir(),"itpay-aftercare-device-proof-"));const server=new DeviceServer();
 const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath:join(root,"identity.json"),privateKeyPath:join(root,"private.pem"),fetchImpl:server.fetch});
 for(const [method,path] of [["GET","/v1/rail-aftercare/case_fixture"],["POST","/v1/rail-aftercare/case_fixture/respond"],["POST","/v1/rail-aftercare/case_fixture/cancel"]] as const) {
 const headers=await authority.authorizationHeaders({method,path,body:method==="GET"?"":"{}"});
 assert.ok(headers.Authorization);assert.match(headers.Authorization,/^ItPayDevice /);assert.ok(headers["X-ItPay-Agent-Signature"]);
 }
 assert.equal(server.enrollmentCount,1);
});


test("retained ticket and guard with a reused PID cannot block a different process",async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-transition-reused-")),statePath=join(root,"identity.json"),pool=statePath+".lock.transition-owners";
 const own=join(pool,process.pid+"-deadbeef");mkdirSync(own,{recursive:true,mode:0o700});writeFileSync(join(own,"ticket"),JSON.stringify({sequence:1,incarnation:"different-process-incarnation"}),{mode:0o600});
 writeFileSync(statePath+".lock.transition",JSON.stringify({pid:process.pid,incarnation:"different-process-incarnation",token:"old"}),{mode:0o600});
 const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem"),fetchImpl:new DeviceServer().fetch});
 await authority.authorizationHeaders({method:"GET",path:"/v1/orders",body:""});assert.equal(existsSync(statePath+".lock"),false);
 assert.equal(readFileSync(join(own,"ticket"),"utf8"),JSON.stringify({sequence:1,incarnation:"different-process-incarnation"}));
});


test("opaque legacy choosing directory is preserved and never inspected",async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-transition-choosing-reused-")),statePath=join(root,"identity.json");
 const own=join(statePath+".lock.transition-owners",process.pid+"-"+"0".repeat(64)+"-deadbeef");mkdirSync(own,{recursive:true,mode:0o700});
 const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem"),fetchImpl:new DeviceServer().fetch});
 await authority.authorizationHeaders({method:"GET",path:"/v1/orders",body:""});
 assert.equal(existsSync(statePath+".lock"),false);assert.equal(existsSync(own),true);assert.equal(existsSync(join(own,"ticket")),false);
});

function cached(options: {statePath: string; privateKeyPath: string; baseURL: string; requestedAgentType: string}) {
 const key = readDeviceKey(options.privateKeyPath);
 assert.ok(key);
 const value = new DeviceSessionCache(join(options.statePath,"..","sessions"),{backend:options.baseURL.replace(/\/$/,""),agentType:options.requestedAgentType,keyThumbprint:deviceKeyThumbprint(key)}).read();
 assert.ok(value);
 return value;
}

for (const phase of ["enrollment", "session"] as const) {
 test(`lost ${phase} verification response retains canonical key and original device`, async () => {
  const root=mkdtempSync(join(tmpdir(),"itpay-response-loss-"));
  const server=new DeviceServer();let lose=true;
  const fetchImpl: typeof fetch=async(input,init)=>{
   const response=await server.fetch(input,init);
   const path=new URL(String(input)).pathname;
   if(lose && path.endsWith("/verify") && path.includes(phase==="enrollment"?"agent-device-enrollments":"agent-device-session-challenges")) {
    lose=false;throw new TypeError("fetch failed",{cause:Object.assign(new Error("synthetic connection closed"),{code:"ECONNRESET"})});
   }
   return response;
  };
  const options={baseURL:"https://test.itpay.ai",requestedAgentType:"workbuddy",compatibilityHeaders:{},statePath:join(root,"identity.json"),privateKeyPath:join(root,"private.pem"),fetchImpl};
  await assert.rejects(new DeviceAuthority(options).authorizationHeaders({method:"GET",path:"/v1/orders",body:""}));
  const before=readFileSync(options.privateKeyPath);
  const result=await new DeviceAuthority(options).authorizationHeaders({method:"GET",path:"/v1/orders",body:""});
  assert.equal(result["X-ItPay-Agent-Instance-ID"],"ain_workbuddy");
  assert.deepEqual(readFileSync(options.privateKeyPath),before);
  assert.equal(server.deviceCount,1);
  assert.equal(server.enrollmentCount,2);
  assert.equal(existsSync(options.statePath),false);
 });
}

// Actual fetch cancellation, not a Promise.race over a stubbed authorization method.
test('authorization deadline aborts slow headers/body before follow-up enrollment or cache commit',async()=>{
 const {createServer}=await import('node:http');
 const {HttpTransportError}=await import('../src/client/transport.js');
 for(const mode of ['headers','body']) {
  const root=mkdtempSync(join(tmpdir(),'itpay-auth-deadline-'));
  const facts=new DeviceServer();const requests:string[]=[];
  const server=createServer(async(req,res)=>{
   requests.push(req.url!);const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
   const response=await facts.fetch(`https://test.itpay.ai${req.url}`,{method:req.method!,body:Buffer.concat(chunks).toString()});
   const raw=await response.text();res.setHeader('content-type','application/json');
   if(mode==='body'){res.writeHead(response.status);res.flushHeaders();res.write(raw.slice(0,1));}
   await new Promise(resolve=>setTimeout(resolve,1500));
   if(!res.destroyed)res.end(mode==='body'?raw.slice(1):raw);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  // Prepare only the synthetic key before starting the budget, so overloaded workspace
  // CI tests in-flight HTTP cancellation rather than key-publication startup timing.
  createDeviceKey(join(root,'private.pem'),false);
  const authority=new DeviceAuthority({baseURL:url,requestedAgentType:'codex-cli',compatibilityHeaders:{},statePath:join(root,'identity.json'),privateKeyPath:join(root,'private.pem')});
  const client=new HttpClient({baseURL:url,requestAuthorizer:i=>authority.authorizationHeaders(i),recoverAuthorization:o=>authority.recoverAuthorization(o)});
  try{
   await assert.rejects(()=>client.post('/v1/carts',{}, {deadline:Date.now()+1000}),error=>error instanceof HttpTransportError&&error.code==='network_timeout');
   const snapshot=()=>JSON.stringify(readdirSync(root,{recursive:true}).filter(x=>String(x).endsWith('.json')).map(x=>[x,readFileSync(join(root,String(x)),'utf8')]));
   const atTimeout=snapshot();await new Promise(resolve=>setTimeout(resolve,1700));
   assert.equal(snapshot(),atTimeout,'no late authorization cache/state commit');
   assert.deepEqual(requests,['/v1/agent-device-enrollments'],'no verification/session/original commerce POST after expiry');
   assert(existsSync(join(root,'private.pem')),'preserve canonical isolated identity even when enrollment outcome is unknown');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
