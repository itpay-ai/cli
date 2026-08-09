export interface BundleTarget {
  version: string;
  format: string;
  bundleDirectory: string;
}

export interface BundleLock {
  version?: string;
  format?: string;
  bundleDirectory?: string;
  [key: string]: unknown;
}

export interface PlatformSyncDecisionInput {
  baseLock?: BundleLock;
  candidateLock?: BundleLock;
  openPullRequestURL?: string;
  target: BundleTarget;
}

export interface PlatformSyncDecision {
  update: boolean;
  reason: "base-current" | "pr-current" | "open-pr-artifact-missing" | "open-pr-artifact-mismatch" | "update-required";
}

export function bundleLockMatches(lock: BundleLock | undefined, target: BundleTarget): boolean;
export function decidePlatformSync(input: PlatformSyncDecisionInput): PlatformSyncDecision;
