import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function bundleLockMatches(lock, target) {
  if (!lock || typeof lock !== "object") return false;
  return lock.version === target.version
    && lock.format === target.format
    && (lock.bundleDirectory || "vendor/itpay-cli") === target.bundleDirectory;
}

export function decidePlatformSync({ baseLock, candidateLock, openPullRequestURL, target }) {
  const parts = value => /^\d+\.\d+\.\d+$/.test(value || "") ? value.split(".").map(Number) : undefined;
  const current = parts(baseLock?.version);
  const requested = parts(target.version);
  if (current && requested) {
    const firstDifference = current.findIndex((part, index) => part !== requested[index]);
    if (firstDifference >= 0 && current[firstDifference] > requested[firstDifference]) {
      return { update: false, reason: "target-older-than-base" };
    }
  }
  if (bundleLockMatches(baseLock, target)) {
    return { update: false, reason: "base-current" };
  }
  if (openPullRequestURL && bundleLockMatches(candidateLock, target)) {
    return { update: false, reason: "pr-current" };
  }
  if (openPullRequestURL && !candidateLock) {
    return { update: true, reason: "open-pr-artifact-missing" };
  }
  if (openPullRequestURL) {
    return { update: true, reason: "open-pr-artifact-mismatch" };
  }
  return { update: true, reason: "update-required" };
}

function readJSON(path) {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function runFromEnvironment() {
  const target = {
    version: process.env.PUBLISHED_VERSION,
    format: process.env.BUNDLE_FORMAT,
    bundleDirectory: process.env.BUNDLE_DIRECTORY || "vendor/itpay-cli",
  };
  if (!target.version || !target.format) {
    throw new Error("PUBLISHED_VERSION and BUNDLE_FORMAT are required");
  }
  const decision = decidePlatformSync({
    baseLock: readJSON(process.env.BASE_LOCK_PATH),
    candidateLock: readJSON(process.env.CANDIDATE_LOCK_PATH),
    openPullRequestURL: process.env.OPEN_PULL_REQUEST_URL || "",
    target,
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `update=${decision.update}\nreason=${decision.reason}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ...decision, target })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromEnvironment();
}
