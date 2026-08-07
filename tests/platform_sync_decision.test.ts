import assert from "node:assert/strict";
import test from "node:test";
import { bundleLockMatches, decidePlatformSync } from "../scripts/platform-sync-decision.mjs";

const target = {
  version: "2.0.26",
  format: "single-file-esm",
  bundleDirectory: "vendor/itpay-cli",
};
const matchingLock = {
  version: target.version,
  format: target.format,
  bundleDirectory: target.bundleDirectory,
  generatedAt: "2026-08-07T00:00:00Z",
};

test("platform sync is a no-op when the base bundle is current", () => {
  assert.deepEqual(decidePlatformSync({ baseLock: matchingLock, target }), {
    update: false,
    reason: "base-current",
  });
});

test("platform sync does not rewrite an already-current open PR", () => {
  assert.deepEqual(decidePlatformSync({
    baseLock: { ...matchingLock, version: "2.0.25" },
    candidateLock: matchingLock,
    openPullRequestURL: "https://github.com/itpay-ai/platform/pull/1",
    target,
  }), {
    update: false,
    reason: "pr-current",
  });
});

test("platform sync rebuilds missing or mismatched PR artifacts", () => {
  assert.deepEqual(decidePlatformSync({
    baseLock: { ...matchingLock, version: "2.0.25" },
    openPullRequestURL: "https://github.com/itpay-ai/platform/pull/1",
    target,
  }).reason, "open-pr-artifact-missing");
  assert.deepEqual(decidePlatformSync({
    baseLock: { ...matchingLock, version: "2.0.25" },
    candidateLock: { ...matchingLock, format: "npm-tree" },
    openPullRequestURL: "https://github.com/itpay-ai/platform/pull/1",
    target,
  }).reason, "open-pr-artifact-mismatch");
});

test("bundle lock matching normalizes the legacy default directory", () => {
  const { bundleDirectory: _omitted, ...legacyLock } = matchingLock;
  assert.equal(bundleLockMatches(legacyLock, target), true);
  assert.equal(bundleLockMatches({ ...matchingLock, version: "2.0.25" }, target), false);
});
