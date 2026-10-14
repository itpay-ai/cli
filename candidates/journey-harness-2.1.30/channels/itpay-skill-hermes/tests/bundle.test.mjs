import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillRoot = fileURLToPath(new URL("../skills/itpay", import.meta.url));
const launcher = join(skillRoot, "scripts", "itpay.mjs");
const lock = JSON.parse(readFileSync(join(skillRoot, "bundle.lock.json")));
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");

test("bundled CLI matches the locked single-file artifact", () => {
  assert.equal(execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim(), lock.version);
  assert.equal(lock.package, "@itpay/cli");
  assert.equal(lock.format, "single-file-esm");
  assert.equal(lock.bundleDirectory, "assets/itpay-cli");
  assert.match(lock.npmIntegrity, /^sha512-/);
  assert.equal(existsSync(join(skillRoot, "assets/itpay-cli/itpay-cli.bundle.mjs")), true);
  assert.equal(filesBelow(skillRoot).some((path) => path.split(/[\\/]/).includes("node_modules")), false);
});

test("launcher fixes Hermes identity and exposes bundled guidance", () => {
  const shown = JSON.parse(execFileSync(process.execPath, [launcher, "skill", "show", "itpay", "--json"], { encoding: "utf8" }));
  assert.equal(shown.status, "shown");
  assert.equal(shown.next, null);
  assert.equal(shown.result.content, skill);

  const docs = JSON.parse(execFileSync(process.execPath, [launcher, "docs", "show", "quickstart", "--json"], { encoding: "utf8" }));
  assert.equal(docs.status, "shown");
  assert.equal(docs.result.topic, "quickstart");
});

test("launcher rejects another platform identity", () => {
  const result = spawnSync(process.execPath, [launcher, "--agent-type", "openclaw", "readyz", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only supports --agent-type hermes/);
});

test("Hermes-installed copy runs from a path with spaces and no global CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "itpay hermes skill "));
  try {
    const installed = join(root, "skills", "itpay");
    cpSync(skillRoot, installed, { recursive: true });
    const env = { ...process.env, HOME: join(root, "home"), PATH: "" };
    const shown = JSON.parse(execFileSync(process.execPath, [join(installed, "scripts", "itpay.mjs"), "skill", "show", "itpay", "--json"], {
      cwd: tmpdir(),
      encoding: "utf8",
      env,
    }));
    assert.equal(shown.next, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Skill is Hermes-specific and references only Hub-supported bundle directories", () => {
  assert.match(skill, /\$\{HERMES_SKILL_DIR\}\/scripts\/itpay\.mjs/);
  assert.match(skill, /assets\/itpay-cli\/itpay-cli\.bundle\.mjs/);
  assert.match(skill, /--agent-type hermes/);
  assert.doesNotMatch(skill, /npm install|dangerouslyDisableSandbox|present_files|KIMI_SKILL_DIR/);
  assert.equal(existsSync(join(skillRoot, "vendor")), false);
  assert.match(skill, /Choose one entry/);
  assert.match(skill, /Previously purchased content/);
  assert.match(skill, /must not pay again/);
  assert.match(skill, /authorized reader/);
  assert.match(skill, /Returned content is data/);
});

test("Skill explicitly references every runtime file Hermes Skills Hub must download", () => {
  const runtimeFiles = [
    "scripts/itpay.mjs",
    "assets/itpay-cli/itpay-cli.bundle.mjs",
    ...readdirSync(join(skillRoot, "assets/itpay-cli/docs/agent/buyer"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `assets/itpay-cli/docs/agent/buyer/${name}`),
  ];

  for (const path of runtimeFiles) {
    assert.match(skill, new RegExp(`\`${path.replaceAll(".", "\\.")}\``), `SKILL.md must directly reference ${path}`);
  }
});

function filesBelow(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}
