#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(skillRoot, "vendor/itpay-cli/package/bin/itp.mjs");
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ITPAY_CLI_SKILLS_DIR: dirname(skillRoot) },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
