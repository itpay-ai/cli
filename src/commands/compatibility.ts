import type { BackendClient } from "../client/backend.js";
import { HttpError } from "../client/http.js";
import { API_CONTRACT_REVISION, CLI_VERSION } from "../state/config.js";

export async function requirePlatformCompatibility(backend: BackendClient): Promise<void> {
  const platform = await backend.compatibility();
  const compatible = platform.api_contract_revision === API_CONTRACT_REVISION
    && compareVersions(CLI_VERSION, platform.minimum_cli_version) >= 0
    && versionMajor(CLI_VERSION) <= platform.maximum_cli_major;
  if (compatible) return;
  throw new HttpError(426, {
    code: "client_upgrade_required",
    message: `CLI ${CLI_VERSION} contract ${API_CONTRACT_REVISION} is incompatible with platform ${platform.platform_revision} contract ${platform.api_contract_revision} (minimum CLI ${platform.minimum_cli_version}, maximum major ${platform.maximum_cli_major})`,
  }, "CLI is incompatible with the active ItPay platform release");
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function versionMajor(version: string): number {
  return versionParts(version)?.[0] ?? Number.MAX_SAFE_INTEGER;
}

function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
