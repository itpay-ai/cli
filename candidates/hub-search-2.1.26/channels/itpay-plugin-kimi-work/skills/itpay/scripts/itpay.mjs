#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(skillRoot, "vendor/itpay-cli/itpay-cli.bundle.mjs");
const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  const declared = value === "--agent-type" ? args[index + 1] : value.startsWith("--agent-type=") ? value.slice(13) : undefined;
  if (declared && declared !== "kimi-code") {
    console.error("This Kimi plugin only supports --agent-type kimi-code.");
    process.exit(2);
  }
}

const child = spawn(process.execPath, [entry, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    ITPAY_AGENT_TYPE: "kimi-code",
    ITPAY_DISTRIBUTION: "kimi-plugin-bundle",
    ITPAY_CLI_DOCS_DIR: resolve(skillRoot, "vendor/itpay-cli/docs/agent/buyer"),
    ITPAY_CLI_SKILLS_DIR: dirname(skillRoot),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
