import { requirePlatformCompatibility } from "./compatibility.js";
import type { BackendClient } from "../client/backend.js";
import { agentAuth } from "../state/account_auth.js";
import { CLI_VERSION, stateDir, type CLIConfig } from "../state/config.js";
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
  const account = await agentAuth("status", config.baseURL, backend, undefined, undefined, { readOnlyStatus: true });
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
    state_directory: stateDir(), state_persistence: "unverified_across_sessions", skill_readable: true, skill_written: "unknown", skill_discoverable: "unknown", execution_position: "unknown", presentation_surface: "unknown",
    device_status: "ready", account_status: account.status, skill_path: skillPath, skill_version: CLI_VERSION,
    ...(account.status === "login_required" ? { account_action: {
      optional: true, condition: "仅当用户要求登录或当前功能需要账号时使用；免费查询不强制绑定。",
      command: "itpay auth login --json", reason: "由本人完成官方账号授权，不自动登录",
    } } : {}),
  }, instruction: (account.status === "authenticated"
    ? "设备已准备好，Services 账号已授权；本次未核验 Hub API 授权。"
    : "设备已准备好；Services 需要账号的功能再请本人授权，本次未核验 Hub API 授权。") + " 按交付物选择同包 Skill：API/结构化数据读 itpay skill show itpay-api --json，再 api discover；办理、交付和售后读 itpay skill show itpay --json。skill_path 是 Services 原路径，不要求 API 先读铁路说明。保留原 launcher、真实宿主和状态目录，新会话不创建新身份；正常任务不重复 setup。新任务仅在宿主获准且能执行 CLI 时优先 CLI，否则使用对应托管 MCP；不要求云宿主试装。已受理、待付款或未知结果只沿原身份、入口和业务引用恢复，不换路重发。",
  next: null, recovery: [] }, { ...options, ...(config.agentType ? { agentType: config.agentType } : {}) });
}
