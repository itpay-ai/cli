#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  const declared = value === "--agent-type" ? args[index + 1] : value.startsWith("--agent-type=") ? value.slice(13) : undefined;
  if (declared && declared !== "hermes") {
    console.error("This Hermes Skill only supports --agent-type hermes.");
    process.exit(2);
  }
}

const child = spawn(process.execPath, [resolve(skillRoot, "assets/itpay-cli/itpay-cli.bundle.mjs"), ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    ITPAY_AGENT_TYPE: "hermes",
    ITPAY_CLI_DOCS_DIR: resolve(skillRoot, "assets/itpay-cli/docs/agent/buyer"),
    ITPAY_CLI_SKILLS_DIR: dirname(skillRoot),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
