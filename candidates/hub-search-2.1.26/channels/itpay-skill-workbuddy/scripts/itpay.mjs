#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(skillRoot, "vendor/itpay-cli/itpay-cli.bundle.mjs");
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    ITPAY_AGENT_TYPE: "workbuddy",
    ITPAY_CLI_DOCS_DIR: resolve(skillRoot, "vendor/itpay-cli/docs/agent/buyer"),
    ITPAY_CLI_SKILLS_DIR: skillRoot,
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
