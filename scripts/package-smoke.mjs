import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
  assert.equal(existsSync(join(packageRoot, "tests")), false, "test transport shim must not ship in the npm package");
  execFileSync("npm", ["install", "--dry-run=false", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
    stdio: "pipe"
  });
  const entry = join(packageRoot, "bin", "itp");
  const env = {
    ...process.env,
    HOME: home,
  };

  const commandPaths = [
    [],
    ["readyz"],
    ["device"], ["device", "recover"],
    ["skill"], ["skill", "show"],
    ["next"],
    ["catalog"], ["catalog", "list"],
    ["install"],
    ["docs"], ["docs", "list"], ["docs", "show"], ["docs", "search"],
    ["cart"], ["cart", "add"], ["cart", "next"], ["cart", "remove"], ["cart", "show"], ["cart", "clear"],
    ["buy"], ["checkout"], ["pay"], ["order"], ["orders"],
    ["refund"], ["refund", "create"], ["refund", "list"], ["refund", "get"], ["refund", "watch"], ["refund", "cancel"],
    ["services"], ["services", "start"], ["services", "invoke"], ["services", "action"], ["services", "quote"],
    ["services", "checkout"], ["services", "list"], ["services", "get"], ["services", "next"],
    ["services", "read-result"], ["services", "events"],
  ];
  for (const commandPath of commandPaths) {
    const commandHelp = execFileSync(process.execPath, [entry, ...commandPath, "--help"], { env, encoding: "utf8" });
    assert.match(commandHelp, /Usage: itpay/, `help failed for: itpay ${commandPath.join(" ")}`);
  }

  const help = execFileSync(process.execPath, [entry, "services", "--help"], { env, encoding: "utf8" });
  assert.match(help, /list/);
  assert.match(help, /read-result/);

  const docs = execFileSync(process.execPath, [entry, "docs", "list"], { env, encoding: "utf8" });
  assert.match(docs, /payment-flow/);
  const installHelp = JSON.parse(execFileSync(process.execPath, [entry, "install", "codex-cli", "--json"], {
    env,
    encoding: "utf8",
  }));
  assert.equal(installHelp.result.agent_type, "codex-cli");
  assert.equal(installHelp.result.default_api, "https://app.itpay.ai");
  const productionEnv = {
    ...process.env,
    HOME: join(scratch, "production-home"),
    ITPAY_BACKEND_URL: "https://dev.itpay.ai",
  };
  mkdirSync(productionEnv.HOME);
  const backendProof = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "device", "recover", "--confirm-backend-reset", "--json",
  ], { env: productionEnv, encoding: "utf8" }));
  assert.equal(backendProof.result.backend, "https://app.itpay.ai");
  const skillHelp = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "skill", "show", "itpay", "--json",
  ], { env, encoding: "utf8" }));
  assert.equal(skillHelp.result.skill, "itpay");
  assert.match(skillHelp.result.content, /One Entry Point, Two Action Domains/);
  assert.match(skillHelp.result.content, /Seller workflows.*not implemented/);
  assert.match(skillHelp.result.content, /Envelope Rule/);
  assert.doesNotMatch(skillHelp.result.content, /next_actions/);
  assert.match(skillHelp.result.content, /15-minute human grant/);
  assert.match(skillHelp.result.content, /Identity And Sessions/);
  assert.equal(skillHelp.next.command, "itpay --agent-type codex-cli catalog list --json");

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
