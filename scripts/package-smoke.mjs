import {createHash} from "node:crypto";
import {verifyNativeSetup} from './native-setup-smoke.mjs';
import {verifyPackedDeviceUpgrade} from './device-upgrade-smoke.mjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  let packageRoot = join(install, "package");
  assert.equal(existsSync(join(packageRoot, "tests")), false, "test transport shim must not ship in the npm package");
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual([...metadata.bundleDependencies].sort(), Object.keys(metadata.dependencies).sort());
  for (const dependency of metadata.bundleDependencies) assert(existsSync(join(packageRoot, "node_modules", dependency, "package.json")), `runtime dependency is absent: ${dependency}`);
  for (const dependency of Object.keys(metadata.devDependencies)) assert.equal(existsSync(join(packageRoot, "node_modules", dependency)), false, `development dependency shipped: ${dependency}`);
  const runtimeInstall = join(scratch, "runtime-install");
  execFileSync("npm", ["install", "--prefix", runtimeInstall, join(packed, tarballs[0]), "--offline", "--dry-run=false", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: install,
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
    stdio: "pipe"
  });
  packageRoot = join(runtimeInstall, "node_modules", "@itpay", "cli");
  const entry = join(packageRoot, "bin", "itp.mjs");
  const env = {
    ...process.env,
    HOME: home,
  };

  const commandDocs = new Map([
    ["", "index.md"],
    ["readyz", "commands/readyz.md"],
    ["setup", "commands/setup.md"],
    ...["auth", "auth login", "auth status"].map(command => [command, "commands/auth.md"]),
    ["device", "commands/device.md"], ["device recover", "commands/device.md"], ["device repair-lock", "commands/device.md"], ["device reset-key", "commands/device.md"],
    ["skill", "commands/skill.md"], ["skill show", "commands/skill.md"],
    ["next", "commands/next.md"],
    ["catalog", "commands/catalog/index.md"], ["catalog list", "commands/catalog/list.md"],
    ["install", "commands/install.md"],
    ["docs", "commands/docs/index.md"], ["docs list", "commands/docs/list.md"],
    ["docs show", "commands/docs/show.md"], ["docs search", "commands/docs/search.md"],
    ["cart", "commands/cart/index.md"], ["cart add", "commands/cart/add.md"],
    ["cart next", "commands/cart/next.md"], ["cart remove", "commands/cart/remove.md"],
    ["cart show", "commands/cart/show.md"], ["cart clear", "commands/cart/clear.md"],
    ["buy", "commands/buy.md"], ["checkout", "commands/checkout.md"], ["pay", "commands/pay.md"],
    ["order", "commands/order.md"], ["orders", "commands/orders.md"],
    ["feedback", "commands/feedback/index.md"], ["feedback submit", "commands/feedback/submit.md"],
    ["refund", "commands/refund/index.md"], ["refund create", "commands/refund/create.md"],
    ["refund list", "commands/refund/list.md"], ["refund get", "commands/refund/get.md"],
    ["refund watch", "commands/refund/watch.md"], ["refund cancel", "commands/refund/cancel.md"],
    ["vault", "commands/vault/index.md"], ["vault list", "commands/vault/list.md"],
    ["vault access", "commands/vault/access.md"], ["vault read", "commands/vault/read.md"],
    ["services", "commands/services/index.md"], ["services start", "commands/services/start.md"],
    ["services run", "commands/services/run.md"],
    ["services invoke", "commands/services/invoke.md"], ["services action", "commands/services/action.md"],
    ["services quote", "commands/services/quote.md"], ["services checkout", "commands/services/checkout.md"],
    ["services list", "commands/services/list.md"], ["services get", "commands/services/get.md"],
    ["services next", "commands/services/next.md"], ["services page", "commands/services/page.md"],
    ["services read-result", "commands/services/read-result.md"],
    ["services events", "commands/services/events.md"],
    ["sell", "commands/sell.md"],
    ...["sell auth", "sell auth login", "sell auth status", "sell auth logout"].map(command => [command, "commands/sell.md"]),
    ["sell status", "commands/sell.md"],
    ["sell guide", "commands/sell.md"],
    ["sell library", "commands/sell.md"],
    ["sell library search", "commands/sell.md"],
    ["sell library get", "commands/sell.md"],
    ["sell sources", "commands/sell.md"],
    ["sell sources list", "commands/sell.md"],
    ["sell sources inspect", "commands/sell.md"],
    ["sell sources import", "commands/sell.md"],
    ["sell sources library", "commands/sell.md"],
    ["sell sources probe", "commands/sell.md"],
    ["sell sources add", "commands/sell.md"],
    ["sell credentials", "commands/sell.md"],
    ["sell credentials status", "commands/sell.md"],
    ["sell credentials bind", "commands/sell.md"],
    ["sell credentials upload", "commands/sell.md"],
    ["sell services", "commands/sell.md"],
    ["sell services list", "commands/sell.md"],
    ["sell services create", "commands/sell.md"],
    ["sell services icon", "commands/sell.md"],
    ["sell services get", "commands/sell.md"],
    ["sell workflow", "commands/sell.md"],
    ["sell workflow catalog", "commands/sell.md"],
    ["sell workflow plan", "commands/sell.md"],
    ["sell workflow plan-get", "commands/sell.md"],
    ["sell workflow plan-apply", "commands/sell.md"],
    ["sell workflow upload", "commands/sell.md"],
    ["sell workflow validate-platform", "commands/sell.md"],
    ["sell workflow versions", "commands/sell.md"],
    ["sell workflow versions list-platform", "commands/sell.md"],
    ["sell workflow versions save-platform", "commands/sell.md"],
    ["sell workflow versions delete-platform", "commands/sell.md"],
    ["sell workflow versions save", "commands/sell.md"],
    ["sell workflow versions list", "commands/sell.md"],
    ["sell workflow versions use", "commands/sell.md"],
    ["sell workflow versions delete", "commands/sell.md"],
    ["sell workflow import", "commands/sell.md"],
    ["sell workflow validate", "commands/sell.md"],
    ["sell workflow confirm", "commands/sell.md"],
    ["sell workflow preview", "commands/sell.md"],
    ["sell fixtures", "commands/sell.md"],
    ["sell fixtures get", "commands/sell.md"],
    ["sell fixtures set", "commands/sell.md"],
    ["sell pricing", "commands/sell.md"],
    ["sell pricing get", "commands/sell.md"],
    ["sell pricing set", "commands/sell.md"],
    ["sell verify", "commands/sell.md"],
    ["sell runs", "commands/sell.md"],
    ["sell runs get", "commands/sell.md"],
    ["sell runs confirm", "commands/sell.md"],
    ["sell submission", "commands/sell.md"],
    ["sell submission preview", "commands/sell.md"],
    ["sell submission submit", "commands/sell.md"],
    ["sell submission get", "commands/sell.md"],
    ["sell submission withdraw", "commands/sell.md"],
    ["sell submission watch", "commands/sell.md"],
    ["sell init", "commands/sell.md"],
    ["sell config", "commands/sell.md"],
    ["sell tests", "commands/sell.md"],
    ["sell tests start-checkout", "commands/sell.md"],
    ["sell tests accept-checkout", "commands/sell.md"],
    ["sell test", "commands/sell.md"],
    ["sell test run", "commands/sell.md"],
    ["sell test resume", "commands/sell.md"],
    ["sell test get", "commands/sell.md"],
    ["sell push", "commands/sell.md"],
    ["sell pull", "commands/sell.md"],
    ["sell mcp", "commands/sell.md"],
  ]);
  for(const path of ["aftercare","aftercare list","aftercare create","aftercare get","aftercare respond","aftercare cancel"]) commandDocs.set(path,"commands/aftercare.md");
  const commandPaths = discoverCommandPaths(entry, env);
  assert.deepEqual(
    [...commandPaths].map((path) => path.join(" ")).sort(),
    [...commandDocs.keys()].sort(),
    "every public command path must have an explicit CLI document mapping",
  );
  const referenceRoot = join(packageRoot, "docs", "cli-reference");
  const referenceIndex = readFileSync(join(referenceRoot, "index.md"), "utf8");
  for (const commandPath of commandPaths) {
    const commandHelp = execFileSync(process.execPath, [entry, ...commandPath, "--help"], { env, encoding: "utf8" });
    assert.match(commandHelp, /Usage: itpay/, `help failed for: itpay ${commandPath.join(" ")}`);
    if (/\n  help \[command\]/.test(commandHelp)) {
      const generatedHelp = execFileSync(process.execPath, [entry, ...commandPath, "help"], { env, encoding: "utf8" });
      assert.match(generatedHelp, /Usage: itpay/, `generated help failed for: itpay ${commandPath.join(" ")} help`);
      assert.match(referenceIndex, /itpay help \[command\]/, "generated help contract is absent from the CLI index");
    }
    const documentPath = commandDocs.get(commandPath.join(" "));
    assert.ok(documentPath, `missing document mapping for: itpay ${commandPath.join(" ")}`);
    const absoluteDocumentPath = join(referenceRoot, documentPath);
    assert.equal(existsSync(absoluteDocumentPath), true, `missing packaged CLI document: ${documentPath}`);
    const document = readFileSync(absoluteDocumentPath, "utf8");
    for (const option of commandHelp.matchAll(/^\s+(?:-\S+,\s+)?--([a-z][a-z0-9-]*)/gm)) {
      if (option[1] === "help") continue;
      assert.match(document, new RegExp(`--${escapeRegExp(option[1])}(?:[^a-z0-9-]|$)`),
        `CLI option is absent from ${documentPath}: itpay ${commandPath.join(" ")} --${option[1]}`);
    }
    if (documentPath !== "index.md") {
      assert.match(referenceIndex, new RegExp(`\\(${escapeRegExp(documentPath)}\\)`), `CLI document is absent from index: ${documentPath}`);
    }
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
  const developmentEnv = {
    ...process.env,
    HOME: join(scratch, "production-home"),
    ITPAY_BACKEND_URL: "https://sandbox.itpay.ai",
  };
  mkdirSync(developmentEnv.HOME);
  const backendProof = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "device", "recover", "--confirm-backend-reset", "--json",
  ], { env: developmentEnv, encoding: "utf8" }));
  assert.equal(backendProof.result.backend, "https://sandbox.itpay.ai");
  assert.match(backendProof.next.command, /^ITPAY_BACKEND_URL=https:\/\/sandbox\.itpay\.ai /);
  const skillHelp = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "skill", "show", "itpay", "--json",
  ], { env, encoding: "utf8" }));
  assert.equal(skillHelp.result.skill, "itpay");
  assert.match(skillHelp.result.content, /Choose one entry/);
  assert.match(skillHelp.result.content, /Show the human/);
  assert.match(skillHelp.result.content, /docs show rail-booking/);
  assert.match(skillHelp.result.content, /Refund/);
  assert.match(skillHelp.result.content, /Keep internal/);
  assert.doesNotMatch(skillHelp.result.content, /next_actions/);
  assert.match(skillHelp.result.content, /official/);
  assert.equal(skillHelp.next, null);
  const refundDocs = JSON.parse(execFileSync(process.execPath, [
    entry, "docs", "search", "钱扣了没结果", "--json",
  ], { env, encoding: "utf8" }));
  assert.deepEqual(refundDocs.result.topics.map((topic) => topic.topic), ["orders-refunds"]);
  assert.doesNotMatch(skillHelp.result.content, /BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/);
  const aliasSkillHelp = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex", "skill", "show", "itpay", "--json",
  ], { env, encoding: "utf8" }));
  assert.equal(aliasSkillHelp.next, null);

  for (const commandPath of [["buy"], ["checkout"], ["services", "checkout"]]) {
    const cardHelp = execFileSync(process.execPath, [entry, ...commandPath, "--help"], { env, encoding: "utf8" });
    assert.match(cardHelp, /--locale <locale>/, `Card locale is undocumented by help: itpay ${commandPath.join(" ")}`);
  }

  let errorOutput = "";
  try {
    execFileSync(process.execPath, [entry, "services", "list"], { env, encoding: "utf8", stdio: "pipe" });
    assert.fail("commerce command without agent type must fail");
  } catch (error) {
    errorOutput = String(error.stdout ?? "");
    assert.equal(String(error.stderr ?? ""), "");
  }
  assert.match(errorOutput, /agent type is required/);
  await verifyPackedDeviceUpgrade(packageRoot, scratch);
  // Pin the actual previous released binary, not a renamed current-code fixture.
  const previousPath = join(scratch, "previous-cli-2.1.45.tgz");
  let previousBytes;
  if (process.argv.length === 4 && process.argv[2] === "--previous-tarball") previousBytes = readFileSync(process.argv[3]);
  else {
    assert.equal(process.argv.length, 2, "unsupported package smoke arguments");
    const response = await fetch("https://registry.npmjs.org/@itpay/cli/-/cli-2.1.45.tgz", { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, "previous official release must be readable");
    previousBytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(createHash("sha256").update(previousBytes).digest("hex"), "560dd9b262e7742347cacbfdd46dea69ed5600fbdc761f1bdc38b667c2c14c36", "previous release bytes must match the verified official artifact");
  writeFileSync(previousPath, previousBytes);
  const nativeSetup = await verifyNativeSetup(join(packed, tarballs[0]), scratch, previousPath);
  process.stdout.write(JSON.stringify(nativeSetup) + "\n");
  process.stdout.write("packed CLI smoke passed\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function discoverCommandPaths(entry, env) {
  const discovered = [[]];
  for (let index = 0; index < discovered.length; index += 1) {
    const parent = discovered[index];
    const help = execFileSync(process.execPath, [entry, ...parent, "--help"], { env, encoding: "utf8" });
    const commands = help.match(/(?:^|\n)Commands:\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
    for (const line of commands.split("\n")) {
      const name = line.match(/^  ([a-z][a-z0-9-]*)(?:\s|$)/)?.[1];
      if (!name || name === "help" || /^\s{4,}/.test(line)) continue;
      discovered.push([...parent, name]);
    }
  }
  return discovered;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
