import assert from "node:assert/strict";
import test from "node:test";

import { canonicalAgentType, declaredAgentType } from "../src/state/agent_type.js";
import { loadConfig } from "../src/state/config.js";

test("canonicalAgentType maps the Codex surface alias to the Backend agent type", () => {
  assert.equal(canonicalAgentType("codex"), "codex-desktop");
  assert.equal(canonicalAgentType(" CODEX "), "codex-desktop");
});

test("canonicalAgentType preserves canonical and unknown normalized values", () => {
  assert.equal(canonicalAgentType("codex-cli"), "codex-cli");
  assert.equal(canonicalAgentType(" WorkBuddy "), "workbuddy");
  assert.equal(canonicalAgentType(" ZCode "), "zcode");
  assert.equal(canonicalAgentType("future-agent"), "future-agent");
  assert.equal(canonicalAgentType("  "), undefined);
});

test("declaredAgentType canonicalizes environment and argument inputs at one boundary", () => {
  assert.equal(declaredAgentType({ ITPAY_AGENT_TYPE: "codex" }, ["node", "itpay", "--agent-type", "workbuddy"]), "codex-desktop");
  assert.equal(declaredAgentType({}, ["node", "itpay", "--agent-type", "codex"]), "codex-desktop");
  assert.equal(declaredAgentType({}, ["node", "itpay", "--agent-type=codex"]), "codex-desktop");
});

test("loadConfig passes only the canonical Codex agent type to device and HTTP clients", () => {
  const config = loadConfig({ ITPAY_AGENT_TYPE: "codex", ITPAY_IDEMPOTENCY_KEY: "test-agent-type" });
  assert.equal(config.agentType, "codex-desktop");
});

test("Personal Agent uses real Dot/Muse identities and a chat presentation", async () => {
 const {isInstallAgentType}=await import("../src/commands/install.js");
 const {defaultHostForAgentType}=await import("../src/state/client_context.js");
 for(const type of ["dot","muse"]) {
  assert.equal(canonicalAgentType(type),type);
  assert.equal(isInstallAgentType(type),true);
  assert.equal(defaultHostForAgentType(type),"plain-chat");
  assert.equal(loadConfig({ITPAY_AGENT_TYPE:type,ITPAY_IDEMPOTENCY_KEY:"fixture"}).agentType,type);
 }
});

test('Approved V4 test origin stays exact, explicit and separate from production',async()=>{
 const {resolveBackendURL,qualifyBackendCommand,TEST_BASE_URL}=await import('../src/state/config.js');
 const env={ITPAY_BACKEND_URL:TEST_BASE_URL,ITPAY_IDEMPOTENCY_KEY:'fixture'};
 assert.equal(resolveBackendURL(env),TEST_BASE_URL);assert.equal(loadConfig(env).environment,'development');assert.equal(qualifyBackendCommand('itpay services get original --json',env),`ITPAY_BACKEND_URL=${TEST_BASE_URL} itpay services get original --json`);
 assert.equal(resolveBackendURL({}),'https://app.itpay.ai');
 for(const bad of ['https://app-test.itpay.ai.evil.test','https://auth-test.itpay.ai','https://mcp-test.itpay.ai','https://app-test.itpay.ai/v1','https://app-test.itpay.ai:8443','https://user@ app-test.itpay.ai','https://app-test.itpay.ai?token=secret'])assert.throws(()=>resolveBackendURL({ITPAY_BACKEND_URL:bad}));
});


test('required actual type is a typed local input contract, never a guessed host',async()=>{
 const {requireAgentType,AgentTypeRequiredError}=await import('../src/state/agent_type.js');
 for(const value of [undefined,'','  '])assert.throws(()=>requireAgentType(value),e=>e instanceof AgentTypeRequiredError&&e.code==='agent_type_required');
 assert.equal(requireAgentType(' WorkBuddy '),'workbuddy');
});
