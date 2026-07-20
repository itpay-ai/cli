import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = resolve(root, ".githooks", "pre-commit");

if (existsSync(hook)) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
    process.stdout.write("Git hooks configured from .githooks\n");
  } catch {
    process.stdout.write("Git hooks not configured: no writable Git checkout\n");
  }
}
