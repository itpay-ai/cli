import type { BackendClient } from "../client/backend.js";
import type { PlatformCompatibility } from "../client/types.js";
import { CLI_VERSION } from "../state/config.js";
import { CommandContractError } from "./guidance.js";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(left: string, right: string): number {
  if (!stableVersion.test(left) || !stableVersion.test(right)) throw new Error("Invalid stable CLI version");
  const a=left.split(".").map(Number),b=right.split(".").map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i])return a[i]! - b[i]!;
  return 0;
}
export function compatibilityRecommendation(platform: PlatformCompatibility): string {
  return typeof platform.recommended_cli === "string" && stableVersion.test(platform.recommended_cli) && compareVersions(platform.recommended_cli, CLI_VERSION)>0
    ? ` 建议按原安装位置更新官方 @itpay/cli@${platform.recommended_cli}，保留原 profile 和请求；当前受支持功能可以继续。` : "";
}
export async function requirePlatformCompatibility(backend: Pick<BackendClient, "compatibility">, capability?: string): Promise<PlatformCompatibility> {
  const platform=await backend.compatibility();
  if (!platform || typeof platform !== "object" || !("minimum_cli" in platform)) {
    const instruction="此环境尚未升级，请使用 dev 入口：https://dev.itpay.ai/agent。已有请求保留原身份与引用，不自动迁移。";
    throw new CommandContractError("environment_upgrade_pending",instruction,instruction,[]);
  }
  if(!stableVersion.test(platform.minimum_cli)
    ||!Array.isArray(platform.blocked_versions)||!platform.blocked_versions.every(v=>typeof v==="string"&&stableVersion.test(v))
) {
    throw new CommandContractError("compatibility_unavailable","Invalid compatibility metadata","此环境兼容信息不可用；保留原请求，稍后重试原入口。",[]);
  }
  if(!Array.isArray(platform.capabilities)) platform.capabilities=[];
  if(compareVersions(CLI_VERSION,platform.minimum_cli)<0||platform.blocked_versions.includes(CLI_VERSION)) {
    throw new CommandContractError("client_upgrade_required","CLI is below minimum or explicitly blocked",
      `请按原安装方式更新满足最低版本 ${platform.minimum_cli} 的官方 CLI，保留原 profile 和请求。`,[],undefined,
      {current_cli_version:CLI_VERSION,minimum_cli:platform.minimum_cli,recommended_cli:platform.recommended_cli});
  }
  if(capability&&!platform.capabilities.includes(capability)) {
    throw new CommandContractError("capability_unavailable",`Capability unavailable: ${capability}`,"此环境尚不支持这项操作；其他已有功能可继续，保留原请求。"+compatibilityRecommendation(platform),[]);
  }
  return platform;
}
