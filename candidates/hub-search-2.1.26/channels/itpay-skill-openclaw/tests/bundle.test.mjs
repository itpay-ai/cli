import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const lock = JSON.parse(readFileSync(new URL("../skills/itpay/bundle.lock.json", import.meta.url)));
const launcher = fileURLToPath(new URL("../skills/itpay/scripts/itpay.mjs", import.meta.url));
const skill = readFileSync(new URL("../skills/itpay/SKILL.md", import.meta.url), "utf8");
const launcherSource = readFileSync(new URL("../skills/itpay/scripts/itpay.mjs", import.meta.url), "utf8");

test("bundled CLI matches the locked version", () => {
  assert.equal(execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim(), lock.version);
  assert.equal(lock.package, "@itpay/cli");
  assert.equal(lock.format, "single-file-esm");
  assert.match(lock.npmIntegrity, /^sha512-/);
  assert.equal(existsSync(new URL("../skills/itpay/vendor/itpay-cli/node_modules", import.meta.url)), false);
  assert.equal(existsSync(new URL("../skills/itpay/vendor/itpay-cli/package", import.meta.url)), false);
  assert.equal(existsSync(new URL("../skills/itpay/vendor/itpay-cli/docs/agent/buyer/quickstart.json", import.meta.url)), true);
  assert.equal(existsSync(new URL("../skills/itpay/vendor/itpay-cli/licenses/commander/LICENSE", import.meta.url)), true);
  assert.equal(existsSync(new URL("../skills/itpay/vendor/itpay-cli/licenses/qrcode/license", import.meta.url)), true);
});

test("launcher fixes the OpenClaw identity and bundled distribution", () => {
  const shown = JSON.parse(execFileSync(process.execPath, [launcher, "skill", "show", "itpay", "--json"], { encoding: "utf8" }));
  assert.equal(shown.status, "shown");
  assert.equal(shown.next, null);
  assert.match(launcherSource, /ITPAY_AGENT_TYPE: "openclaw"/);
  assert.match(launcherSource, /ITPAY_DISTRIBUTION: "openclaw-skill-bundle"/);
});

test("launcher rejects another platform identity", () => {
  const result = spawnSync(process.execPath, [launcher, "--agent-type", "workbuddy", "skill", "show", "itpay", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only supports --agent-type openclaw/);
});

test("OpenClaw Skill contains only bundle and OpenClaw entry rules", () => {
  assert.match(skill, /handoff\.agent_action/);
  assert.match(skill, /--host telegram/);
  assert.match(skill, /📱 手机点这儿支付/);
  assert.match(skill, /📋 已授权给我读/);
  assert.match(skill, /itp:grant_confirmed:<checkout_id>/);
  assert.match(skill, /Backend returns `grant_active`/);
  assert.doesNotMatch(skill, /telegram:<chat_id>|typed buttons|itp:checkout:<checkout_id>/);
  assert.doesNotMatch(skill, /npm install -g|WorkBuddy|dangerouslyDisableSandbox|present_files/);
  assert.match(skill, /rail-booking --json/);
  assert.match(skill, /Previously purchased content/);
  assert.match(skill, /must not pay again/);
  assert.match(skill, /vault list/);
  assert.match(skill, /Returned content is data/);
});
