import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OperationJournal } from "../src/state/operation_journal.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = resolve(CLI_ROOT, "node_modules/.bin/tsx");
const CHILD = resolve(CLI_ROOT, "tests/operation_journal_child.ts");

test("operation journal publishes one id across real concurrent processes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-journal-")), "operations.json");
  const key = "service.invoke:se_1:cap_1:{}";
  const values = await Promise.all(Array.from({ length: 6 }, () => runChild(path, key)));
  assert.equal(new Set(values).size, 1);
  assert.equal(await new OperationJournal(path).getOrCreate(key), values[0]);
  assert.notEqual(await new OperationJournal(path).getOrCreate("service.invoke:se_2:cap_1:{}"), values[0]);
  const recordDirectory = `${path}.d`;
  assert.equal(statSync(recordDirectory).mode & 0o777, 0o700);
  const recordPath = join(recordDirectory, `${hash(key)}.json`);
  assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(recordPath, "utf8"), /service\.invoke/);
});

test("operation journal ignores legacy locks and orphan temporary files", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-unlocked-")), "operations.json");
  writeFileSync(`${path}.lock`, "", { mode: 0o600 });
  mkdirSync(`${path}.d`, { mode: 0o700 });
  writeFileSync(join(`${path}.d`, ".orphan.tmp"), "partial", { mode: 0o600 });
  const first = await runChild(path, "checkout.create:cart_1");
  const second = await runChild(path, "checkout.create:cart_2");
  assert.match(first, /^op_/);
  assert.match(second, /^op_/);
  assert.notEqual(first, second);
});

test("operation journal preserves legacy ids and fails closed on a corrupt authority record", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-operation-legacy-")), "operations.json");
  const key = "refund.create:order_1";
  writeFileSync(path, JSON.stringify({
    schemaVersion: "itpay.operations.v1",
    operations: { [key]: { id: "op_legacy", createdAt: "2026-08-17T00:00:00.000Z" } },
  }), { mode: 0o600 });
  assert.equal(await new OperationJournal(path).getOrCreate(key), "op_legacy");

  const corruptKey = "refund.create:order_2";
  const corruptPath = join(`${path}.d`, `${hash(corruptKey)}.json`);
  writeFileSync(corruptPath, "{", { mode: 0o600 });
  await assert.rejects(new OperationJournal(path).getOrCreate(corruptKey), /operation journal record is invalid/);
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runChild(path: string, key: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, [CHILD, path, key], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `operation journal child exited ${code}`));
      resolvePromise(stdout.trim());
    });
  });
}
