import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const lock = JSON.parse(readFileSync(new URL("../skills/itpay/bundle.lock.json", import.meta.url)));
const launcher = fileURLToPath(new URL("../skills/itpay/scripts/itpay.mjs", import.meta.url));
const skill = readFileSync(new URL("../skills/itpay/SKILL.md", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url)));
const openAI = readFileSync(new URL("../skills/itpay/agents/openai.yaml", import.meta.url), "utf8");
const reviewCases = readFileSync(new URL("../submission/test-cases.md", import.meta.url), "utf8");

test("bundled CLI matches the locked version", () => {
  assert.equal(execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim(), lock.version);
  assert.equal(lock.package, "@itpay/cli");
  assert.match(lock.npmIntegrity, /^sha512-/);
});

test("ChatGPT uses only read-only MCP while local Codex keeps the CLI", () => {
  for (const tool of ["itpay_account_status", "itpay_orders_list", "itpay_vault_list", "itpay_vault_authorize", "itpay_vault_result_read"]) {
    assert.match(skill, new RegExp(tool));
  }
  assert.match(skill, /ChatGPT MCP cannot purchase, pay, or refund/);
  assert.match(skill, /Local Codex CLI/);
  assert.match(skill, /Never ask for, display, or store an OAuth token/);
  assert.match(skill, /Choose one entry/);
  assert.match(skill, /Run technology for the human/);
  assert.doesNotMatch(skill, /npm install -g/);
  assert.deepEqual(manifest.interface.capabilities, ["Read"]);
  assert.doesNotMatch(JSON.stringify(manifest.interface), /buy|purchase|Checkout|refund/i);
  assert.match(openAI, /list my Vault artifacts/);
  assert.doesNotMatch(openAI, /Checkout|purchase|refund/i);
  assert.match(reviewCases, /cloud MCP is read-only/);
});
