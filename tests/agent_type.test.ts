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
