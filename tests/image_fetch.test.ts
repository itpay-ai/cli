import assert from "node:assert/strict";
import test from "node:test";

import { HttpTransportError } from "../src/client/transport.js";
import { downloadBrandQRToTmp } from "../src/render/ide.js";
import { fetchImage } from "../src/render/image_fetch.js";

function resetFailure(): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
}

test("image fetch retries a safe GET with one request id and numbered attempts", async () => {
  const headers: Headers[] = [];
  const events: string[] = [];
  const image = await fetchImage("https://dev.itpay.ai/v1/checkouts/chk_1/card.png?display_token=secret", {
    transportRetryDelayMs: 0,
    transportObserver: (event) => events.push(`${event.outcome}:${event.path}:${event.attempt}`),
    fetchImpl: async (_input, init) => {
      headers.push(new Headers(init?.headers));
      if (headers.length < 3) throw resetFailure();
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    },
  });
  assert.equal(image.contentType, "image/png");
  assert.equal(image.body.toString("hex"), "89504e47");
  assert.equal(new Set(headers.map((item) => item.get("X-ItPay-Request-ID"))).size, 1);
  assert.deepEqual(headers.map((item) => item.get("X-ItPay-Request-Attempt")), ["1", "2", "3"]);
  assert.deepEqual(events, [
    "retrying:/v1/checkouts/chk_1/card.png:1",
    "retrying:/v1/checkouts/chk_1/card.png:2",
    "recovered:/v1/checkouts/chk_1/card.png:3",
  ]);
  assert.equal(events.some((event) => event.includes("display_token")), false);
});

test("image fetch reports a stable exhausted transport error", async () => {
  await assert.rejects(
    fetchImage("https://dev.itpay.ai/card.png?display_token=secret", {
      transportRetryDelayMs: 0,
      transportDiagnosticLog: "/safe/transport.jsonl",
      fetchImpl: async () => { throw resetFailure(); },
    }),
    (error: unknown) => error instanceof HttpTransportError &&
      error.code === "network_connection_reset" &&
      error.attempts === 3 &&
      error.diagnosticLog === "/safe/transport.jsonl" &&
      !error.message.includes("secret"),
  );
});

test("image fetch does not retry an HTTP response", async () => {
  let calls = 0;
  await assert.rejects(
    fetchImage("https://dev.itpay.ai/card.png", {
      transportRetryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response("unavailable", { status: 503 });
      },
    }),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("IDE attach failure exposes only the safe correlation and diagnostic location", async () => {
  const result = await downloadBrandQRToTmp(
    "https://dev.itpay.ai/card.png?display_token=must-not-leak",
    "checkout",
    "chk_transport",
    {
      transportRetryDelayMs: 0,
      transportDiagnosticLog: "/safe/transport.jsonl",
      fetchImpl: async () => { throw resetFailure(); },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /network_connection_reset/);
  assert.match(result.reason ?? "", /request_id=req_[a-f0-9]{32}/);
  assert.match(result.reason ?? "", /attempts=3/);
  assert.match(result.reason ?? "", /diagnostic_log=\/safe\/transport\.jsonl/);
  assert.doesNotMatch(result.reason ?? "", /must-not-leak|display_token/);
});
