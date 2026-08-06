import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationJournal } from "../src/state/operation_journal.js";
import { TransportDiagnostics } from "../src/state/transport_diagnostics.js";

test("operation journal persists one id across concurrent instances and restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-journal-")), "operations.json");
  const values = await Promise.all(Array.from({ length: 20 }, () => new OperationJournal(path).getOrCreate("service.invoke:se_1:cap_1:{}")));
  assert.equal(new Set(values).size, 1);
  assert.equal(await new OperationJournal(path).getOrCreate("service.invoke:se_1:cap_1:{}"), values[0]);
  assert.notEqual(await new OperationJournal(path).getOrCreate("service.invoke:se_2:cap_1:{}"), values[0]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("operation completion removes only the matching pending intent", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-complete-")), "operations.json");
  const journal = new OperationJournal(path);
  const first = await journal.getOrCreate("service.start:svc_1:{}");
  await journal.complete("service.start:svc_1:{}", "different");
  assert.equal(await journal.getOrCreate("service.start:svc_1:{}"), first);
  await journal.complete("service.start:svc_1:{}", first);
  assert.notEqual(await journal.getOrCreate("service.start:svc_1:{}"), first);
});

test("transport diagnostics persist only bounded safe fields in an owner-only file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-transport-diagnostics-")), "transport.jsonl");
  const diagnostics = new TransportDiagnostics(path);
  diagnostics.observe({
    timestamp: "2026-08-06T14:18:44.000Z",
    request_id: "req_0123456789abcdef0123456789abcdef",
    method: "GET",
    origin: "https://dev.itpay.ai",
    path: "/v1/checkouts/chk_1/card.png",
    attempt: 1,
    outcome: "retrying",
    elapsed_ms: 12,
    code: "network_connection_reset",
    cause_code: "ECONNRESET",
  });
  const content = readFileSync(path, "utf8");
  assert.match(content, /req_0123456789abcdef0123456789abcdef/);
  assert.match(content, /network_connection_reset/);
  assert.doesNotMatch(content, /display_token|Authorization|secret/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
