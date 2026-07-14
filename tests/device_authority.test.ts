import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HttpClient, HttpError } from "../src/client/http.js";
import { DeviceAuthority, DeviceAuthorizationError, DeviceStateError } from "../src/state/device_authority.js";

test("device authority enrolls once, survives concurrent processes, and registers another agent type", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-"));
  const statePath = join(root, "identity.json");
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

  const requestCount = server.requestCount;
  await new DeviceAuthority(options).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });
  assert.equal(server.requestCount, requestCount, "valid persisted session should not contact enrollment server");

  for (const path of ["/v1/orders/ord_1/refunds", "/v1/refunds/rr_1/cancel"]) {
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

test("device authority replaces a stale legacy file lock with the directory lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-device-legacy-lock-"));
  const statePath = join(root, "identity.json");
  const lockPath = `${statePath}.lock`;
  writeFileSync(lockPath, "");
  const stale = new Date(Date.now() - 31_000);
  utimesSync(lockPath, stale, stale);

  const server = new DeviceServer();
  const headers = await new DeviceAuthority({
    baseURL: "https://test.itpay.ai", requestedAgentType: "workbuddy", compatibilityHeaders: {},
    statePath, privateKeyPath: join(root, "private.pem"), fetchImpl: server.fetch,
  }).authorizationHeaders({ method: "GET", path: "/v1/service-executions", body: "" });

  assert.equal(headers["X-ItPay-Agent-Instance-ID"], "ain_workbuddy");
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
      error.code === "device_state_unwritable" &&
      error.operation === "prepare_lock" &&
      error.causeCode === "EEXIST" &&
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
  private publicKey: ReturnType<typeof createPublicKey> | undefined;
  private readonly instances = new Map<string, string>();

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
      this.instances.set("codex-cli", "ain_codex_cli");
      return json({ agent_device_id: "adev_1", agent_device_key_id: "akey_1", quota_lineage_id: "qln_1", agent_instance_id: "ain_codex_cli", agent_type: "codex-cli" });
    }
    if (path === "/v1/agent-instances") {
      assert.match(String(new Headers(init?.headers).get("Authorization")), /^ItPayDevice /);
      const id = `ain_${body.agent_type!.replaceAll("-", "_")}`;
      this.instances.set(body.agent_type!, id);
      return json({ agent_instance_id: id });
    }
    if (path === "/v1/agent-device-session-challenges") {
      if (this.revoked) return json({ code: "agent_device_revoked", message: "agent device is revoked" }, 403);
      const agentType = [...this.instances].find(([, id]) => id === body.agent_instance_id)?.[0];
      if (!agentType) return json({ code: "agent_device_revoked", message: "agent device is not registered here" }, 403);
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
