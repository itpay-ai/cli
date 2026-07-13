import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DeviceAuthority } from "../src/state/device_authority.js";

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
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { agentInstances: Record<string, string> };
  assert.deepEqual(state.agentInstances, {
    "codex-cli": "ain_codex_cli",
    "claude-code-cli": "ain_claude_code_cli",
  });
});

class DeviceServer {
  enrollmentCount = 0;
  requestCount = 0;
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
      const agentType = [...this.instances].find(([, id]) => id === body.agent_instance_id)?.[0];
      assert.ok(agentType);
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
