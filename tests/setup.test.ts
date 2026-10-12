import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { runSetup, validateSetup } from "../src/commands/setup.js";
import { loadConfig, CLI_VERSION } from "../src/state/config.js";
import { HttpError } from "../src/client/http.js";
import { CommandContractError } from "../src/commands/guidance.js";

test("setup validates actual type and current package Skill before any backend request", () => {
  assert.throws(() => validateSetup(undefined), /supported actual Agent Type/);
  assert.throws(() => validateSetup("not-a-host"), /supported actual Agent Type/);
  assert.equal(isAbsolute(validateSetup("workbuddy")), true);
});

for (const status of ["authenticated", "login_required", "unknown", "404", "426", "503"]) {
 test(`setup ${status} keeps preparation separate from login and business`, async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-setup-contract-"));
  const old = process.env.ITPAY_STATE_DIR; process.env.ITPAY_STATE_DIR = root;
  let calls = 0; const lines: string[] = [];
  const backend = {
   async agentAccountStatus() { calls++; if (/^\d+$/.test(status)) throw new HttpError(Number(status), {code: "fixture_failure", message: "fixture failure"}, "fixture failure"); return { status }; },
   async bindAgentAccount(): Promise<{status: string}> { throw new Error("setup must not bind or log in"); },
  };
  const config = loadConfig({ ITPAY_AGENT_TYPE: "workbuddy", ITPAY_BACKEND_URL: "https://dev.itpay.ai", ITPAY_IDEMPOTENCY_KEY: "setup-test" });
  try {
   const run = () => runSetup(backend, config, validateSetup("workbuddy"), {jsonOutput: true, output: s => lines.push(s)});
   if (["authenticated", "login_required"].includes(status)) {
    await run(); await run(); assert.equal(calls, 2); assert.equal(lines.length, 2);
    for (const line of lines) { const x = JSON.parse(line); assert.equal(x.status, "setup_ready"); assert.equal(x.result.account_status, status); assert.equal(x.result.cli_version, CLI_VERSION); assert.equal(x.next, null); assert(!/session_token|private_key|start_token/.test(line)); }
    const plain: string[] = []; await runSetup(backend, config, validateSetup("workbuddy"), {output: s => plain.push(s)});
    assert.match(plain.join(""), /设备已准备好/);
   } else {
    await assert.rejects(run, status === "404" || status === "426" ? HttpError : CommandContractError);
    assert.equal(lines.length, 0); assert.equal(calls, 1);
   }
  } finally { if (old === undefined) delete process.env.ITPAY_STATE_DIR; else process.env.ITPAY_STATE_DIR = old; rmSync(root, {recursive: true, force: true}); }
 });
}
