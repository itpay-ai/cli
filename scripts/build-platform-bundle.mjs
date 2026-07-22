import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [version, outputArg] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !outputArg) {
  throw new Error("usage: node scripts/build-platform-bundle.mjs <exact-version> <output-directory>");
}

const output = resolve(outputArg);
const vendor = join(output, "vendor", "itpay-cli");
const scratch = mkdtempSync(join(tmpdir(), "itpay-platform-bundle-"));

try {
  const metadata = JSON.parse(execFileSync("npm", [
    "view", `@itpay/cli@${version}`, "version", "dist.integrity", "gitHead", "engines", "--json",
  ], { encoding: "utf8" }));
  if (metadata.version !== version || !metadata["dist.integrity"] || !metadata.gitHead) {
    throw new Error(`incomplete npm metadata for @itpay/cli@${version}`);
  }

  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    name: "itpay-platform-bundle",
    private: true,
    dependencies: { "@itpay/cli": version },
  }, null, 2) + "\n");
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: "inherit",
  });

  const installed = join(scratch, "node_modules", "@itpay", "cli");
  const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (installedPackage.version !== version) throw new Error(`installed ${installedPackage.version}, expected ${version}`);

  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(join(vendor, "package"), { recursive: true });
  cpSync(installed, join(vendor, "package"), { recursive: true });
  rmSync(installed, { recursive: true, force: true });
  const scope = dirname(installed);
  if (existsSync(scope)) rmSync(scope, { recursive: true, force: true });
  renameSync(join(scratch, "node_modules"), join(vendor, "node_modules"));
  cpSync(join(scratch, "package-lock.json"), join(vendor, "package-lock.json"));

  const dependencyLock = readFileSync(join(vendor, "package-lock.json"));
  const lock = {
    schemaVersion: 1,
    package: "@itpay/cli",
    version,
    npmIntegrity: metadata["dist.integrity"],
    sourceGitSha: metadata.gitHead,
    generatedAt: new Date().toISOString(),
    node: metadata.engines?.node ?? ">=18",
    dependencyLockSha256: createHash("sha256").update(dependencyLock).digest("hex"),
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "bundle.lock.json"), JSON.stringify(lock, null, 2) + "\n");

  const entry = join(vendor, "package", "bin", "itp");
  const actual = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" }).trim();
  if (actual !== version) throw new Error(`bundle reported ${actual}, expected ${version}`);
  process.stdout.write(`built @itpay/cli@${version} in ${output}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
