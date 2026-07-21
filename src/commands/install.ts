import type { OutputSink } from "../render/sink.js";
import { DEFAULT_BASE_URL } from "../state/config.js";
import { defaultHostForAgentType } from "../state/client_context.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

export const INSTALL_AGENT_TYPES = [
  "codex-desktop",
  "codex-cli",
  "claude-code-desktop",
  "claude-code-cli",
  "workbuddy",
] as const;

type InstallAgentType = (typeof INSTALL_AGENT_TYPES)[number];

export interface InstallOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
}

const INSTRUCTIONS: Record<InstallAgentType, string> = {
  "codex-desktop": "在 Codex Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "codex-cli": "在 Codex CLI 中始终传这个 Agent Type；付款交接只应显示在用户可见终端。",
  "claude-code-desktop": "在 Claude Code Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "claude-code-cli": "在 Claude Code CLI 中始终传这个 Agent Type；付款交接只应显示在用户可见终端。",
  workbuddy: "在 WorkBuddy 中始终传这个 Agent Type。运行会持久化 ~/.itpay-v3 的 ItPay Bash 命令前，把 Shell 工具参数 dangerouslyDisableSandbox 设为 true；用户拒绝权限时停止，不要切换 Node、删除 identity 或处理 lock。Checkout 返回 qr_image_url 时，按当次 instruction 调用 present_files 在右侧打开二维码，不要检查本地二维码文件。",
};

export function runInstall(target: string | undefined, options: InstallOptions = {}): void {
  if (!target || target === "list") {
    const agentTypes = INSTALL_AGENT_TYPES.map((agentType) => ({
      agent_type: agentType,
      default_host: defaultHostForAgentType(agentType),
    }));
    writeCommandEnvelope({
      status: "install_targets",
      result: { agent_types: agentTypes },
      instruction: "选择当前真实运行环境；同一 Agent 不要临时更换 Agent Type。",
      next: null,
      recovery: [{ command: "itpay docs show install-and-setup", reason: "查看安装与环境说明" }],
    }, {
      ...options,
      plainResult: agentTypes.map((item) => `${item.agent_type}: ${item.default_host}`),
    });
    return;
  }

  const normalized = target.trim().toLowerCase();
  if (!isInstallAgentType(normalized)) {
    throw new CommandContractError(
      "unsupported_agent_type",
      `unsupported install target: ${target}`,
      `target 只接受：${INSTALL_AGENT_TYPES.join(", ")}。`,
      [{ command: "itpay install --json", reason: "列出正式支持的 Agent Type" }],
    );
  }

  writeCommandEnvelope({
    status: "instructions_ready",
    result: {
      agent_type: normalized,
      default_host: defaultHostForAgentType(normalized),
      default_api: DEFAULT_BASE_URL,
      install_command: "npm install -g @itpay/cli",
    },
    instruction: INSTRUCTIONS[normalized],
    next: {
      command: `itpay --agent-type ${normalized} readyz --json`,
      reason: "验证当前官方 ItPay API 的可用性",
    },
    recovery: [{ command: "itpay docs show install-and-setup", reason: "查看官方 Backend 和首次使用说明" }],
  }, options);
}

function isInstallAgentType(value: string): value is InstallAgentType {
  return (INSTALL_AGENT_TYPES as readonly string[]).includes(value);
}
