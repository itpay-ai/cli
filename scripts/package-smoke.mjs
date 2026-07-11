import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "itpay-cli-package-"));
const packed = join(scratch, "packed");
const install = join(scratch, "install");
const home = join(scratch, "home");
mkdirSync(packed);
mkdirSync(install);
mkdirSync(home);

try {
  execFileSync("npm", ["pack", "--dry-run=false", "--ignore-scripts", "--pack-destination", packed], {
    cwd: root,
    stdio: "pipe",
  });
  const tarballs = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "npm pack must create exactly one tarball");
  execFileSync("tar", ["-xzf", join(packed, tarballs[0]), "-C", install]);

  const packageRoot = join(install, "package");
  execFileSync("npm", ["install", "--dry-run=false", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: packageRoot,
    stdio: "pipe"
  });
  const entry = join(packageRoot, "bin", "itp");
  const env = { ...process.env, HOME: home, ITPAY_BACKEND_URL: "http://127.0.0.1:1" };
  const help = execFileSync(process.execPath, [entry, "services", "--help"], { env, encoding: "utf8" });
  assert.match(help, /list/);
  assert.match(help, /read-result/);

  const docs = execFileSync(process.execPath, [entry, "docs", "list"], { env, encoding: "utf8" });
  assert.match(docs, /payment-flow/);
  const installHelp = execFileSync(process.execPath, [entry, "install", "codex"], { env, encoding: "utf8" });
  assert.match(installHelp, /Default API:/);
  assert.doesNotMatch(installHelp, /Production API/);
  assert.match(installHelp, /https:\/\/app\.itpay\.ai/);
  assert.doesNotMatch(installHelp, /sandbox\.itpay\.ai/);
  const skill = readFileSync(join(packageRoot, "skills", "itpay-buyer", "SKILL.md"), "utf8");
  assert.match(skill, /next_actions/);
  assert.match(skill, /15 minutes/);

  let stderr = "";
  try {
    execFileSync(process.execPath, [entry, "services", "list"], { env, encoding: "utf8", stdio: "pipe" });
    assert.fail("commerce command without agent type must fail");
  } catch (error) {
    stderr = String(error.stderr ?? "");
  }
  assert.match(stderr, /agent type is required/);
  process.stdout.write("packed CLI smoke passed\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
