import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const lock = JSON.parse(readFileSync(new URL("../bundle.lock.json", import.meta.url)));
const launcher = fileURLToPath(new URL("../scripts/itpay.mjs", import.meta.url));
const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

function filesBelow(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

test("bundled CLI matches the locked version", () => {
  assert.equal(execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim(), lock.version);
  assert.equal(lock.package, "@itpay/cli");
  assert.equal(lock.format, "single-file-esm");
  assert.match(lock.npmIntegrity, /^sha512-/);
});

test("upload bundle contains no npm tree", () => {
  assert.equal(filesBelow(skillRoot).some((path) => path.split(/[\\/]/).includes("node_modules")), false);
  assert.equal(existsSync(new URL("../SKILL.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../skills/itpay/SKILL.md", import.meta.url)), false);
  assert.equal(existsSync(new URL("../vendor/itpay-cli/package", import.meta.url)), false);
  assert.equal(existsSync(new URL("../vendor/itpay-cli/itpay-cli.bundle.mjs", import.meta.url)), true);
  assert.equal(existsSync(new URL("../vendor/itpay-cli/docs/agent/buyer/quickstart.json", import.meta.url)), true);
  assert.equal(filesBelow(skillRoot).some((path) => /^licen[cs]e(?:[._-].*)?$/i.test(path.split(/[\\/]/).at(-1))), false);
});

test("WorkBuddy Skill keeps its platform contract", () => {
  assert.doesNotMatch(skill, /dangerouslyDisableSandbox/);
  assert.match(skill, /rail-booking --json/);
  assert.match(skill, /execute `handoff\.agent_action` exactly once when present/);
  assert.match(skill, /complete official `handoff\.url` as its only `files` element/);
  assert.match(skill, /Never use\s+`present_files` for a local file or QR PNG/);
  assert.match(skill, /workbuddy/);
  assert.doesNotMatch(skill, /npm install -g/);
  assert.match(skill, /Default to this local CLI/);
  assert.match(skill, /Explicit MCP Vault Read/);
  assert.match(skill, /Choose one entry/);
  assert.match(skill, /Previously purchased content/);
  assert.match(skill, /select under the human\'s delegation/);
  assert.ok(skill.indexOf("## Explicit MCP Vault Read") < skill.indexOf("Use the CLI as the only ItPay control surface in this lane"));
  for (const tool of ["itpay_account_status", "itpay_orders_list", "itpay_vault_list", "itpay_vault_authorize", "itpay_vault_result_read"]) {
    assert.match(skill, new RegExp(tool));
  }
});

test("installed Skill works from an arbitrary path without global npm or itpay", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "itpay workbuddy "));
  try {
    const installed = join(sandbox, "renamed WorkBuddy upload");
    const home = join(sandbox, "home");
    mkdirSync(installed);
    for (const entry of ["SKILL.md", "agents", "bundle.lock.json", "scripts", "vendor"]) {
      cpSync(join(skillRoot, entry), join(installed, entry), { recursive: true });
    }
    mkdirSync(home);
    const installedLauncher = join(installed, "scripts", "itpay.mjs");
    const env = { ...process.env, HOME: home, PATH: "" };
    const shownSkill = JSON.parse(execFileSync(process.execPath, [installedLauncher, "skill", "show", "itpay", "--json"], { encoding: "utf8", env }));
    const shownDocs = JSON.parse(execFileSync(process.execPath, [installedLauncher, "docs", "show", "quickstart", "--json"], { encoding: "utf8", env }));
    assert.equal(shownSkill.status, "shown");
    assert.equal(shownSkill.result.skill, "itpay");
    assert.equal(shownSkill.result.content, readFileSync(join(installed, "SKILL.md"), "utf8"));
    assert.equal(shownSkill.next, null);
    assert.equal(shownDocs.status, "shown");
    assert.equal(shownDocs.result.topic, "quickstart");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
