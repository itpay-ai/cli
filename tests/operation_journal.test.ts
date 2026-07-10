import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationJournal } from "../src/state/operation_journal.js";

test("operation journal persists one id across concurrent instances and restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-journal-")), "operations.json");
  const values = await Promise.all(Array.from({ length: 20 }, () => new OperationJournal(path).getOrCreate("service.invoke:se_1:cap_1:{}")));
  assert.equal(new Set(values).size, 1);
  assert.equal(await new OperationJournal(path).getOrCreate("service.invoke:se_1:cap_1:{}"), values[0]);
  assert.notEqual(await new OperationJournal(path).getOrCreate("service.invoke:se_2:cap_1:{}"), values[0]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
