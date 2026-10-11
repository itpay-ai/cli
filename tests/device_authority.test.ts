import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncBuiltinESMExports } from "node:module";

import { HttpClient, HttpError } from "../src/client/http.js";
import { DeviceAuthority, DeviceAuthorizationError, DeviceStateError } from "../src/state/device_authority.js";

test("device authority enrolls once, survives concurrent processes, and registers another agent type", async () => {
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
  assert.equal(server.enrollmentCount, 1);
  assert.equal(first["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
  assert.equal(concurrent["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(statSync(privateKeyPath).mode & 0o777, 0o600);
  assert.equal(existsSync(`${statePath}.lock`), false);
  assert.equal(readdirSync(join(statePath, "..")).some(name => name.startsWith("identity.json.lock.released.")), true);

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
  assert.equal(server.enrollmentCount, 1);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    schemaVersion: string;
    registrations: Record<string, { agentInstances: Record<string, string> }>;
  };
  assert.equal(state.schemaVersion, "itpay.device.v2");
  assert.deepEqual(state.registrations["https://test.itpay.ai"]?.agentInstances, {
    "codex-cli": "ain_codex_cli",
    "claude-code-cli": "ain_claude_code_cli",
  });
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
  assert.deepEqual(server.registrationAuthorizers.slice(-2), ["codex-cli", "claude-code-cli"]);
  assert.equal(server.enrollmentCount, 1, "a revoked instance must not create a replacement device");
});

test("device authority stops when every existing instance is revoked", async () => {
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
  server.revokedAgentTypes.add("codex-cli");
  server.revokedAgentTypes.add("claude-code-cli");

  await assert.rejects(
    () => new DeviceAuthority({ ...options, requestedAgentType: "workbuddy" })
      .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" }),
    (error: unknown) => error instanceof DeviceAuthorizationError && error.code === "agent_device_revoked",
  );
  assert.equal(server.enrollmentCount, 1, "revoked instances must not create a replacement device");
});

test("ownerless legacy directory requires operator evidence rather than stealing an old caller", () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-legacy-lock-"));
  const statePath = join(root, "identity.json");
  const lockPath = `${statePath}.lock`;
  mkdirSync(lockPath);
  const stale = new Date(Date.now() - 31_000);
  utimesSync(lockPath, stale, stale);
  writeFileSync(`${lockPath}.stale`, "preserved");
  const authority = new DeviceAuthority({ baseURL: "https://test.itpay.ai", compatibilityHeaders: {}, statePath, privateKeyPath: join(root, "private.pem") });
  assert.throws(() => authority.repairLock(), (error: unknown) => error instanceof DeviceStateError && error.causeCode === "LEGACY_LOCK_OWNER_UNKNOWN");
  assert.equal(statSync(lockPath).isDirectory(), true);
  assert.equal(readFileSync(`${lockPath}.stale`, "utf8"), "preserved");
});

test("device identity lock lifecycle does not depend on sandbox delete operations", () => {
  const source = readFileSync(new URL("../src/state/device_authority.ts", import.meta.url), "utf8");
  const lockLifecycle = source.slice(source.indexOf("async function withFileLock"), source.indexOf("function asDeviceStateError"));
  assert.doesNotMatch(lockLifecycle, /\b(?:unlinkSync|rmdirSync)\b/);
  assert.match(lockLifecycle, /renameSync/);
});

test("exited owner lock preserves existing directory and file archives and recovers", async () => {
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
  assert.equal(existsSync(lockPath), false);
  assert.equal(readFileSync(`${lockPath}.stale/history`, "utf8"), "prior-stale");
  assert.equal(readFileSync(`${lockPath}.released`, "utf8"), "prior-released");
  assert.equal(readdirSync(root).filter(name => name.startsWith("identity.json.lock.stale.")).length, 1);
  assert.equal(readdirSync(root).filter(name => name.startsWith("identity.json.lock.released.")).length, 1);
  assert.equal(server.enrollmentCount, 1);
});

test("device repair-lock preserves live owners and recovers exited owners", () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-repair-lock-"));
  const statePath = join(root, "identity.json");
  const lockPath = `${statePath}.lock`;
  const authority = new DeviceAuthority({
    baseURL: "https://test.itpay.ai", compatibilityHeaders: {}, statePath,
    privateKeyPath: join(root, "private.pem"),
  });
  writeFileSync(lockPath, `${process.pid}:live`);
  assert.equal(authority.repairLock(), "active");
  assert.equal(readFileSync(lockPath, "utf8"), `${process.pid}:live`);
  writeFileSync(lockPath, "99999999:deadbeef");
  assert.equal(authority.repairLock(), "recovered");
  assert.equal(existsSync(lockPath), false);
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
      error.operation === "prepare_lock" &&
      error.causeCode === "EEXIST" &&
      error.blockedPath === "/dev/null" &&
      error.message === "ItPay device state operation failed: prepare_lock (EEXIST)",
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

  const state = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, unknown> };
  assert.deepEqual(Object.keys(state.registrations).sort(), ["https://dev.itpay.ai", "https://test.itpay.ai"]);
  assert.equal(testServer.enrollmentCount, 1);
  assert.equal(devServer.enrollmentCount, 1);

  const privateKey = readFileSync(privateKeyPath, "utf8");
  const recovered = await new DeviceAuthority({
    baseURL: "https://dev.itpay.ai", requestedAgentType: "codex-desktop", compatibilityHeaders: {}, statePath, privateKeyPath, fetchImpl,
  }).recoverBackendReset();
  assert.deepEqual(recovered, { removed: true, agentTypes: ["codex-cli", "codex-desktop"] });
  assert.equal(readFileSync(privateKeyPath, "utf8"), privateKey);
  const recoveredState = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, unknown> };
  assert.deepEqual(Object.keys(recoveredState.registrations), ["https://test.itpay.ai"]);
});

test("device authority migrates a v1 registration only after the backend proves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-v1-"));
  const statePath = join(root, "identity.json");
  const privateKeyPath = join(root, "private.pem");
  const server = new DeviceServer();
  const options = { baseURL: "https://test.itpay.ai", requestedAgentType: "codex-cli", compatibilityHeaders: {}, statePath, privateKeyPath, fetchImpl: server.fetch };
  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  const current = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, Record<string, unknown>> };
  const registration = current.registrations["https://test.itpay.ai"]!;
  writeFileSync(statePath, JSON.stringify({ schemaVersion: "itpay.device.v1", ...registration }), { mode: 0o600 });
  const requestCount = server.requestCount;

  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });

  const migrated = JSON.parse(readFileSync(statePath, "utf8")) as { schemaVersion: string; registrations: Record<string, unknown>; legacyRegistration?: unknown };
  assert.equal(migrated.schemaVersion, "itpay.device.v2");
  assert.ok(migrated.registrations["https://test.itpay.ai"]);
  assert.equal(migrated.legacyRegistration, undefined);
  assert.ok(server.requestCount > requestCount, "v1 migration must renew against the selected backend");
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
  const current = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, Record<string, unknown>> };
  writeFileSync(statePath, JSON.stringify({ schemaVersion: "itpay.device.v1", ...current.registrations["https://test.itpay.ai"] }), { mode: 0o600 });

  await new DeviceAuthority({ ...options, baseURL: "https://dev.itpay.ai" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  let migrated = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, unknown>; legacyRegistration?: unknown };
  assert.ok(migrated.registrations["https://dev.itpay.ai"]);
  assert.ok(migrated.legacyRegistration, "unclaimed v1 registration must remain available for its original backend");
  assert.equal(devServer.enrollmentCount, 1);

  await new DeviceAuthority({ ...options, baseURL: "https://test.itpay.ai" })
    .authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  migrated = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, unknown>; legacyRegistration?: unknown };
  assert.deepEqual(Object.keys(migrated.registrations).sort(), ["https://dev.itpay.ai", "https://test.itpay.ai"]);
  assert.equal(migrated.legacyRegistration, undefined);
  assert.equal(testServer.enrollmentCount, 1, "proven v1 registration must be reused without enrolling again");
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
      return json({ agent_device_enrollment_id: "enr_1", challenge: "enroll_nonce" });
    }
    if (path === "/v1/agent-device-enrollments/enr_1/verify") {
      this.assertSignature("itpay-device-enrollment/v1\nenr_1\nenroll_nonce", body.signature!);
      if (this.failEnrollmentVerify) {
        return json({ code: "internal_error", message: "request failed" }, 500);
      }
      this.instances.set("codex-cli", "ain_codex_cli");
      this.devices.add("adev_1");
      return json({ agent_device_id: "adev_1", agent_device_key_id: "akey_1", quota_lineage_id: "qln_1", agent_instance_id: "ain_codex_cli", agent_type: "codex-cli" });
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

  // Simulate the crash window: the server committed the device but the local
  // registration write never happened. Only identity.json is lost.
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
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, { sessions: Record<string, unknown> }> };
  state.registrations["https://test.itpay.ai"]!.sessions = {};
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  server.forgetDevices();

  const second = await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(server.enrollmentCount, 2, "the stale registration is dropped and the device re-enrolls");
  assert.equal(second["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
});

test("device authority marks enrollment failures so guidance can offer key reset", async () => {
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

test("device authority resetDeviceKey discards the key and every registration", async () => {
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

  const reset = await authority.resetDeviceKey();
  assert.deepEqual(reset.removedBackends, ["https://test.itpay.ai"]);
  assert.equal(existsSync(privateKeyPath), false);
  const cleared = JSON.parse(readFileSync(statePath, "utf8")) as { registrations: Record<string, unknown> };
  assert.deepEqual(cleared.registrations, {});

  // The next authorization generates a brand-new key pair and enrolls fresh.
  const headers = await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(headers["X-ItPay-Agent-Instance-ID"], "ain_codex_cli");
  assert.equal(server.enrollmentCount, 2);
  assert.notEqual(readFileSync(privateKeyPath, "utf8"), previousKey);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

for (const code of ["EACCES", "EPERM", "ENOTDIR", "EISDIR", "CODEBUDDY_BROKER_DENY", "CODEBUDDY_BROKER_OUTCOME_UNKNOWN", "UNKNOWN_TEST_CODE"]) {
  test(`lock acquisition classifies ${code} at the file operation boundary`, async () => {
    const root = mkdtempSync(join(tmpdir(), "itpay-lock-error-"));
    const original = fs.writeFileSync;
    const patch = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith(".lock")) throw Object.assign(new Error("private diagnostic omitted"), { code });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(new DeviceAuthority({ baseURL: "https://test.itpay.ai", compatibilityHeaders: {},
        statePath: join(root, "identity.json"), privateKeyPath: join(root, "private.pem"), fetchImpl: new DeviceServer().fetch,
      }).authorizationHeaders({ method: "GET", path: "/v1/orders", body: "" }), (error: unknown) => {
        assert.ok(error instanceof DeviceStateError);
        assert.equal(error.operation, "acquire_lock");
        assert.equal(error.causeCode, code === "UNKNOWN_TEST_CODE" ? "UNCLASSIFIED_LOCAL_FAILURE" : code);
        assert.equal(error.source, code.startsWith("CODEBUDDY_") ? "host_broker" : code === "UNKNOWN_TEST_CODE" ? "unclassified_local_operation" : "native_filesystem");
        assert.doesNotMatch(error.message, /private diagnostic/);
        return true;
      });
    } finally { patch.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("release failure does not replace the original enrollment failure", async () => {
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

test("recovery stops when the inspected source changes", () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-lock-changed-"));
  const statePath = join(root, "identity.json"), lock = `${statePath}.lock`;
  writeFileSync(lock, "99999999:deadbeef");
  const original = fs.lstatSync;
  let calls = 0;
  const patch = mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === lock && ++calls === 2) writeFileSync(lock, `${process.pid}:deadbeef`);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const authority = new DeviceAuthority({baseURL:"https://test.itpay.ai",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem")});
    assert.throws(() => authority.repairLock(), (error: unknown) => error instanceof DeviceStateError && error.causeCode === "LOCK_SOURCE_CHANGED");
    assert.equal(readFileSync(lock,"utf8"), `${process.pid}:deadbeef`);
  } finally {patch.mock.restore();syncBuiltinESMExports();}
});

test("lock inspection does not follow symlinks or reclaim an unprobeable owner", () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-lock-symlink-"));
  const statePath = join(root,"identity.json"), lock=`${statePath}.lock`, outside=join(root,"outside");
  writeFileSync(outside,"preserved");fs.symlinkSync(outside,lock);
  const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem")});
  assert.throws(()=>authority.repairLock(),(error:unknown)=>error instanceof DeviceStateError && error.causeCode==="SYMLINK_LOCK");
  assert.equal(readFileSync(outside,"utf8"),"preserved");
  fs.unlinkSync(lock);writeFileSync(lock,"99999999:deadbeef");
  const patch=mock.method(process,"kill",()=>{throw Object.assign(new Error("not allowed"),{code:"EPERM"});});
  try {assert.equal(authority.repairLock(),"active");assert.equal(readFileSync(lock,"utf8"),"99999999:deadbeef");} finally {patch.mock.restore();}
});

test("independent processes recover an exited owner once without replacing another transition", async () => {
  const root=mkdtempSync(join(tmpdir(),"itpay-lock-processes-")), statePath=join(root,"identity.json");
  writeFileSync(`${statePath}.lock`,"99999999:deadbeef");
  const source=new URL("../src/state/device_authority.ts",import.meta.url).href;
  const script=`import {DeviceAuthority} from ${JSON.stringify(source)}; const a=new DeviceAuthority({baseURL:"https://test.itpay.ai",compatibilityHeaders:{},statePath:${JSON.stringify(statePath)},privateKeyPath:${JSON.stringify(join(root,"private.pem"))}}); console.log(a.repairLock());`;
  const results=await Promise.all(Array.from({length:4},()=>promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",script],{cwd:new URL("../",import.meta.url)})));
  assert.equal(results.filter(r=>r.stdout.trim()==="recovered").length,1);
  assert.equal(readdirSync(root).filter(n=>n.startsWith("identity.json.lock.stale.")).length,1);
  assert.equal(existsSync(`${statePath}.lock`),false);
});


test("release waits for a competing live-owner inspection without taking its guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-release-transition-"));
  const statePath = join(root, "identity.json");
  const server = new DeviceServer();
  let inspected = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await server.fetch(input, init);
    if (String(input).includes("agent-device-session-challenges/") && String(input).endsWith("/verify")) {
      const guard = `${statePath}.lock.transition`;
      mkdirSync(guard);
      setTimeout(() => { fs.renameSync(guard, `${guard}.fixture-inspection`); inspected = true; }, 50);
    }
    return response;
  };
  await new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem"),fetchImpl}).authorizationHeaders({method:"GET",path:"/v1/orders",body:""});
  assert.equal(inspected, true);
  assert.equal(existsSync(`${statePath}.lock`), false);
  assert.equal(existsSync(`${statePath}.lock.transition.fixture-inspection`), true);
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

for(const phase of ["choosing","ready","linked"] as const) test(`interrupted transition ${phase} ticket does not block recovery`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-transition-crash-"));const statePath=join(root,"identity.json");
 const script=`import {mkdirSync,writeFileSync,linkSync} from 'node:fs';import {randomUUID} from 'node:crypto';const own=${JSON.stringify(statePath+".lock.transition-owners/")}+process.pid+'-'+randomUUID();mkdirSync(own,{recursive:true,mode:0o700});${phase!=="choosing" ? "writeFileSync(own+'/ticket','1',{mode:0o600});" : ""}${phase==="linked" ? "writeFileSync(own+'/owner',process.pid+':'+randomUUID(),{mode:0o600});linkSync(own+'/owner',"+JSON.stringify(statePath+".lock.transition")+");" : ""}process.exit(17);`;
 await assert.rejects(promisify(execFile)(process.execPath,["--input-type=module","-e",script]),(error:unknown)=>typeof error==="object" && error!==null && "code" in error && error.code===17);
 const pool=statePath+".lock.transition-owners";const entries=readdirSync(pool).filter(name=>name!=="archives");
 const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",requestedAgentType:"codex-cli",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem"),fetchImpl:new DeviceServer().fetch});
 assert.equal(authority.repairLock(),"absent");await authority.authorizationHeaders({method:"GET",path:"/v1/orders",body:""});
 assert.deepEqual(readdirSync(pool).filter(name=>name!=="archives"),entries);assert.equal(existsSync(statePath+".lock"),false);
});


test("transition recovery never steals an old active published owner",()=>{
 const root=mkdtempSync(join(tmpdir(),"itpay-transition-live-"));const statePath=join(root,"identity.json"),guard=statePath+".lock.transition";
 const token=process.pid+":deadbeef";writeFileSync(guard,token,{mode:0o600});utimesSync(guard,new Date(0),new Date(0));
 const authority=new DeviceAuthority({baseURL:"https://test.itpay.ai",compatibilityHeaders:{},statePath,privateKeyPath:join(root,"private.pem")});
 assert.equal(authority.repairLock(),"active");assert.equal(readFileSync(guard,"utf8"),token);
});
