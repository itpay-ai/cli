import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendClient } from "../src/client/backend.js";
import { HttpClient } from "../src/client/http.js";
import { HttpTransportError } from "../src/client/transport.js";

function transportFailure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("retries a transient GET twice and regenerates authorization for every attempt", async () => {
  let calls = 0;
  let authorizations = 0;
  const requestIDs: string[] = [];
  const attempts: string[] = [];
  const diagnostics: string[] = [];
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    requestAuthorizer: async () => ({ Authorization: `proof_${++authorizations}` }),
    transportObserver: (event) => diagnostics.push(`${event.outcome}:${event.path}:${event.attempt}`),
    fetchImpl: async (_input, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `proof_${calls}`);
      requestIDs.push(headers.get("X-ItPay-Request-ID") ?? "");
      attempts.push(headers.get("X-ItPay-Request-Attempt") ?? "");
      if (calls <= 2) throw transportFailure("ECONNRESET");
      return json({ status: "ready" });
    },
  });

  assert.deepEqual(await client.get("/v1/readyz"), { status: "ready" });
  assert.equal(calls, 3);
  assert.equal(authorizations, 3);
  assert.equal(new Set(requestIDs).size, 1);
  assert.match(requestIDs[0] ?? "", /^req_[a-f0-9]{32}$/);
  assert.deepEqual(attempts, ["1", "2", "3"]);
  assert.deepEqual(diagnostics, ["retrying:/v1/readyz:1", "retrying:/v1/readyz:2", "recovered:/v1/readyz:3"]);
});

test("service start is replayed only when it carries its stable idempotency key", async () => {
  for (const idempotencyKey of ["op_start_1", undefined]) {
    let calls = 0;
    const backend = new BackendClient(new HttpClient({
      baseURL: "https://test.itpay.ai",
      transportRetryDelayMs: 0,
      fetchImpl: async (_input, init) => {
        calls += 1;
        assert.equal(new Headers(init?.headers).get("Idempotency-Key"), idempotencyKey ?? null);
        if (calls === 1) throw transportFailure("ECONNRESET");
        return json({ execution: { service_execution_id: "se_1" } });
      },
    }));
    const start = () => backend.startServiceExecution({ service_id: "svc_1" }, idempotencyKey);
    if (idempotencyKey) {
      assert.equal((await start()).execution.service_execution_id, "se_1");
      assert.equal(calls, 2);
    } else {
      await assert.rejects(start, (error: unknown) => error instanceof HttpTransportError && error.attempts === 1);
      assert.equal(calls, 1);
    }
  }
});

test("retries an idempotency-keyed POST once with the identical request", async () => {
  const requests: Array<{ body: unknown; idempotencyKey: string | null }> = [];
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    fetchImpl: async (_input, init) => {
      requests.push({
        body: init?.body,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      if (requests.length === 1) throw transportFailure("UND_ERR_CONNECT_TIMEOUT");
      return json({ checkout_id: "chk_1" });
    },
  });

  assert.deepEqual(
    await client.post("/v1/checkouts", { cart_id: "cart_1" }, { idempotencyKey: "idem_1" }),
    { checkout_id: "chk_1" },
  );
  assert.deepEqual(requests, [
    { body: JSON.stringify({ cart_id: "cart_1" }), idempotencyKey: "idem_1" },
    { body: JSON.stringify({ cart_id: "cart_1" }), idempotencyKey: "idem_1" },
  ]);
});

test("service checkout opts into replay only because its backend operation is transactionally recoverable", async () => {
  let calls = 0;
  const backend = new BackendClient(new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw transportFailure("ECONNRESET");
      return json({ binding: { service_execution_id: "se_1" } });
    },
  }));

  const response = await backend.createServiceExecutionCheckout("se_1", { capability_id: "report" });
  assert.equal(response.binding.service_execution_id, "se_1");
  assert.equal(calls, 2);
});

test("service invocation retries only when its provider operation has an idempotency key", async () => {
  for (const idempotencyKey of ["invoke_1", undefined]) {
    let calls = 0;
    const backend = new BackendClient(new HttpClient({
      baseURL: "https://test.itpay.ai",
      transportRetryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw transportFailure("ECONNRESET");
        return json({ execution: { service_execution_id: "se_1" } });
      },
    }));
    const invoke = () => backend.invokeServiceCapability("se_1", "lookup", {
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      redacted_summary: { keyword: "ItPay" },
    });

    if (idempotencyKey) {
      assert.equal((await invoke()).execution.service_execution_id, "se_1");
      assert.equal(calls, 2);
    } else {
      await assert.rejects(invoke, (error: unknown) =>
        error instanceof HttpTransportError && error.attempts === 1);
      assert.equal(calls, 1);
    }
  }
});

test("does not replay an unsafe POST after a transport failure", async () => {
  let calls = 0;
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      throw transportFailure("ECONNRESET");
    },
  });

  await assert.rejects(
    () => client.post("/v1/payment-intents", { method: "alipay" }),
    (error: unknown) => error instanceof HttpTransportError &&
      error.code === "network_connection_reset" && error.attempts === 1 && error.causeCode === "ECONNRESET",
  );
  assert.equal(calls, 1);
});

test("classifies an authorizer transport failure without replaying its internal writes", async () => {
  let authorizations = 0;
  let protectedCalls = 0;
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    requestAuthorizer: async () => {
      authorizations += 1;
      throw transportFailure("ECONNRESET");
    },
    fetchImpl: async () => {
      protectedCalls += 1;
      return json({ executions: [] });
    },
  });

  await assert.rejects(
    () => client.get("/v1/service-executions"),
    (error: unknown) => error instanceof HttpTransportError &&
      error.code === "network_connection_reset" && error.attempts === 1,
  );
  assert.equal(authorizations, 1, "the outer GET replay policy must not replay enrollment/session POSTs");
  assert.equal(protectedCalls, 0, "the protected request must not run without authorization");
});

test("stops after two bounded retries and reports a stable transport classification", async () => {
  let calls = 0;
  const client = new HttpClient({
    baseURL: "https://test.itpay.ai",
    transportRetryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      throw transportFailure("ECONNRESET");
    },
  });

  await assert.rejects(
    () => client.get("/v1/orders/ord_1"),
    (error: unknown) => error instanceof HttpTransportError &&
      error.code === "network_connection_reset" && error.attempts === 3 &&
      error.message.includes("after 3 attempts"),
  );
  assert.equal(calls, 3);
});

test("does not retry aborts or permanent TLS certificate failures", async () => {
  for (const failure of [
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
    new TypeError("fetch failed", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) }),
  ]) {
    let calls = 0;
    const client = new HttpClient({
      baseURL: "https://test.itpay.ai",
      transportRetryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        throw failure;
      },
    });
    await assert.rejects(() => client.get("/v1/readyz"), (error: unknown) => error === failure);
    assert.equal(calls, 1);
  }
});

test("real socket response loss replays one idempotent service start without duplicate execution", async (t) => {
  let requests = 0;
  let creations = 0;
  const requestIDs: string[] = [];
  const attempts: string[] = [];
  const executions = new Map<string, string>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests += 1;
      const key = String(request.headers["idempotency-key"] ?? "");
      requestIDs.push(String(request.headers["x-itpay-request-id"] ?? ""));
      attempts.push(String(request.headers["x-itpay-request-attempt"] ?? ""));
      if (!executions.has(key)) {
        executions.set(key, "se_socket_once");
        creations += 1;
      }
      if (requests === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ execution: { service_execution_id: executions.get(key) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const backend = new BackendClient(new HttpClient({ baseURL, transportRetryDelayMs: 0 }));

  const result = await backend.startServiceExecution({ service_id: "svc_socket" }, "op_socket_once");
  assert.equal(result.execution.service_execution_id, "se_socket_once");
  assert.equal(requests, 2);
  assert.equal(creations, 1);
  assert.equal(new Set(requestIDs).size, 1);
  assert.match(requestIDs[0] ?? "", /^req_[a-f0-9]{32}$/);
  assert.deepEqual(attempts, ["1", "2"]);
});
