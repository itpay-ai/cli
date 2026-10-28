import { authStatePath } from '../src/state/auth_storage.js';
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

import { runSetup, validateSetup } from "../src/commands/setup.js";
import { loadConfig, CLI_VERSION, API_CONTRACT_REVISION } from "../src/state/config.js";
import { HttpError } from "../src/client/http.js";
import { CommandContractError } from "../src/commands/guidance.js";

test("setup validates actual type and current package Skill before any backend request", () => {
  assert.throws(() => validateSetup(undefined), /supported actual Agent Type/);
  assert.throws(() => validateSetup("not-a-host"), /supported actual Agent Type/);
  assert.equal(isAbsolute(validateSetup("workbuddy")), true);
});

for (const status of ["authenticated", "login_required", "unknown", "unbound", "404", "426", "503"]) {
 test(`setup ${status} keeps preparation separate from login and business`, async () => {
  const root = mkdtempSync(join(tmpdir(), "itpay-setup-contract-"));
  const oldFetch=globalThis.fetch; globalThis.fetch=async()=>{throw Error("setup must not poll browser authorization");};
  const old = process.env.ITPAY_STATE_DIR; process.env.ITPAY_STATE_DIR = root;
  let calls = 0; const lines: string[] = [];
  const backend = {
   async compatibility() { return { api_contract_revision: API_CONTRACT_REVISION, minimum_cli_version: "2.1.40", maximum_cli_major: 2, platform_revision: "fixture", schema_revision: "fixture", bootstrap_revision: "fixture" }; },
   async agentAccountStatus() { calls++; if (/^\d+$/.test(status)) throw new HttpError(Number(status), {code: "fixture_failure", message: "fixture failure"}, "fixture failure"); return { status }; },
   async bindAgentAccount(): Promise<{status: string}> { throw new Error("setup must not bind or log in"); },
  };
  const config = loadConfig({ ITPAY_AGENT_TYPE: "workbuddy", ITPAY_BACKEND_URL: "https://dev.itpay.ai", ITPAY_IDEMPOTENCY_KEY: "setup-test" });
  const sessionPath=authStatePath(config.baseURL,process.env,"agent-login");
  mkdirSync(root,{recursive:true});
  writeFileSync(sessionPath, ["unknown", "503", "unbound"].includes(status) ? "corrupt saved browser file" : JSON.stringify({baseURL:config.baseURL,sessionID:"completed-browser-session",pollToken:"synthetic",startToken:"synthetic"}));
  const sessionBefore=readFileSync(sessionPath);
  try {
   const run = () => runSetup(backend, config, validateSetup("workbuddy"), {jsonOutput: true, output: s => lines.push(s)});
   if (["authenticated", "login_required"].includes(status)) {
    await run(); await run(); assert.equal(calls, 2); assert.equal(lines.length, 2);
    for (const line of lines) { const x = JSON.parse(line); assert.equal(x.status, "setup_ready"); assert.equal(x.result.account_status, status); assert.equal(x.result.cli_version, CLI_VERSION); assert.equal(x.next, null); if(status==="login_required"){assert.equal(x.result.account_action.optional,true);assert.match(x.result.account_action.command,/--agent-type workbuddy auth login/);}else assert.equal(x.result.account_action,undefined); assert(!/session_token|private_key|start_token/.test(line)); }
    const plain: string[] = []; await runSetup(backend, config, validateSetup("workbuddy"), {output: s => plain.push(s)});
    assert.match(plain.join(""), /设备已准备好/);
   } else {
    await assert.rejects(run, status === "404" || status === "426" ? HttpError : CommandContractError);
    assert.equal(lines.length, 0); assert.equal(calls, 1);
   }
   assert.deepEqual(readFileSync(sessionPath),sessionBefore);
  } finally { globalThis.fetch=oldFetch; if (old === undefined) delete process.env.ITPAY_STATE_DIR; else process.env.ITPAY_STATE_DIR = old; rmSync(root, {recursive: true, force: true}); }
 });
}

 test("setup incompatible API fails before device/account work", async () => {
  const config=loadConfig({ITPAY_AGENT_TYPE:"workbuddy",ITPAY_IDEMPOTENCY_KEY:"fixture"});
  const backend={
   async compatibility(){return {api_contract_revision:"other",minimum_cli_version:"2.1.40",maximum_cli_major:2,platform_revision:"fixture",schema_revision:"fixture",bootstrap_revision:"fixture"};},
   async agentAccountStatus(): Promise<{status:string}>{throw Error("must not read account on incompatible Backend");},
   async bindAgentAccount(): Promise<{status:string}>{throw Error("must not bind");},
  };
  await assert.rejects(()=>runSetup(backend,config,validateSetup("workbuddy")),e=>e instanceof HttpError&&e.status===426);
 });
