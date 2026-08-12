import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

  const commandDocs = new Map([
    ["", "index.md"],
    ["readyz", "commands/readyz.md"],
    ["device", "commands/device.md"], ["device recover", "commands/device.md"],
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
    ["refund", "commands/refund/index.md"], ["refund create", "commands/refund/create.md"],
    ["refund list", "commands/refund/list.md"], ["refund get", "commands/refund/get.md"],
    ["refund watch", "commands/refund/watch.md"], ["refund cancel", "commands/refund/cancel.md"],
    ["vault", "commands/vault/index.md"], ["vault list", "commands/vault/list.md"],
    ["vault access", "commands/vault/access.md"], ["vault read", "commands/vault/read.md"],
    ["services", "commands/services/index.md"], ["services start", "commands/services/start.md"],
    ["services invoke", "commands/services/invoke.md"], ["services action", "commands/services/action.md"],
    ["services quote", "commands/services/quote.md"], ["services checkout", "commands/services/checkout.md"],
    ["services list", "commands/services/list.md"], ["services get", "commands/services/get.md"],
    ["services next", "commands/services/next.md"], ["services read-result", "commands/services/read-result.md"],
    ["services events", "commands/services/events.md"],
  ]);
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
    ITPAY_BACKEND_URL: "https://dev.itpay.ai",
  };
  mkdirSync(developmentEnv.HOME);
  const backendProof = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "device", "recover", "--confirm-backend-reset", "--json",
  ], { env: developmentEnv, encoding: "utf8" }));
  assert.equal(backendProof.result.backend, "https://dev.itpay.ai");
  assert.match(backendProof.next.command, /^ITPAY_BACKEND_URL=https:\/\/dev\.itpay\.ai /);
  const skillHelp = JSON.parse(execFileSync(process.execPath, [
    entry, "--agent-type", "codex-cli", "skill", "show", "itpay", "--json",
  ], { env, encoding: "utf8" }));
  assert.equal(skillHelp.result.skill, "itpay");
  assert.match(skillHelp.result.content, /Route The Human's Intent/);
  assert.match(skillHelp.result.content, /Serve The Human/);
  assert.match(skillHelp.result.content, /Explain refund eligibility as a policy route, not a promise/);
  assert.match(skillHelp.result.content, /View previously purchased content/);
  assert.match(skillHelp.result.content, /Keep the same Agent Type, official Backend, access lane/);
  assert.doesNotMatch(skillHelp.result.content, /next_actions/);
  assert.match(skillHelp.result.content, /Present one official authorization handoff/);
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
