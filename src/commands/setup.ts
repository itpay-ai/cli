import { requirePlatformCompatibility } from "./compatibility.js";
import type { BackendClient } from "../client/backend.js";
import { agentAuth } from "../state/account_auth.js";
import { CLI_VERSION, type CLIConfig } from "../state/config.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";
import type { OutputSink } from "../render/sink.js";
import { INSTALL_AGENT_TYPES, isInstallAgentType } from "./install.js";
import { packagedSkill } from "./skill.js";

export function validateSetup(agentType: string | undefined): string {
  if (!agentType || !isInstallAgentType(agentType)) {
    throw new CommandContractError("unsupported_agent_type", "setup requires a supported actual Agent Type",
      `准备未完成：宿主类型。可用类型：${INSTALL_AGENT_TYPES.join(", ")}。`,
      [{ command: "itpay install --json", reason: "识别实际宿主类型" }]);
  }
  try { return packagedSkill().path; }
  catch (error) {
    const cause = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "invalid_packaged_skill";
    throw new CommandContractError("packaged_skill_unavailable", "current package Skill is missing or invalid",
    "准备未完成：同包 Skill 不可读取。按返回原因确认宿主正常读取权限或恢复原位置的完整官方包。", [], undefined,
      { failure_stage: "packaged_skill", cause_code: cause }); }
}

export async function runSetup(backend: Pick<BackendClient, "agentAccountStatus" | "bindAgentAccount" | "compatibility">, config: CLIConfig, skillPath: string,
  options: { jsonOutput?: boolean; output?: OutputSink } = {}): Promise<void> {
  await requirePlatformCompatibility(backend);
  const account = await agentAuth("status", config.baseURL, backend);
  if (!account || typeof account !== "object" || !("status" in account)
    || (account.status !== "authenticated" && account.status !== "login_required")) {
    const detail = account && typeof account === "object" && "result" in account
      && account.result && typeof account.result === "object" && !Array.isArray(account.result)
      ? account.result : {};
    throw new CommandContractError("setup_status_unconfirmed", "device or account status is unconfirmed",
      "设备或账号状态尚未确认，本次准备未完成。保留现有身份，按返回的原因处理。", [], undefined,
      { failure_stage: "account_status", ...detail });
  }
  writeCommandEnvelope({ status: "setup_ready", result: {
    cli_version: CLI_VERSION, backend_url: config.baseURL, agent_type: config.agentType,
    device_status: "ready", account_status: account.status, skill_path: skillPath, skill_version: CLI_VERSION,
  }, instruction: account.status === "authenticated"
    ? "设备已准备好，已有账号授权可继续使用。读取并启用下方 Skill 后，按用户需求开始。"
    : "设备已准备好。读取并启用下方 Skill 后即可开始；需要账号的功能会再请用户授权。",
  next: null, recovery: [] }, options);
}
