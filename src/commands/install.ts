import type { OutputSink } from "../render/sink.js";
import { DEFAULT_BASE_URL } from "../state/config.js";
import { defaultHostForAgentType } from "../state/client_context.js";
import { CommandContractError, writeCommandEnvelope } from "./guidance.js";

export const INSTALL_AGENT_TYPES = [
  "dot",
  "muse",
  "codex-desktop",
  "codex-cli",
  "claude-code-desktop",
  "claude-code-cli",
  "workbuddy",
  "zcode",
  "doubao-work",
  "kimi-code",
  "openclaw",
  "hermes",
] as const;

type InstallAgentType = (typeof INSTALL_AGENT_TYPES)[number];

export interface InstallOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
}

export const CODEX_WAIT_GUIDANCE = "Codex 宿主等待：保留完整工具返回，按实际返回的会话句柄及当前宿主续读工具收取最终输出，不要只取 stdout。若使用 functions.exec 包装，可用 text(await tools.exec_command(...))；内层有 session_id 时用 write_stdin，外层返回运行 cell 时才用 wait。没有该包装时按宿主实际工具操作。先收取最终输出，再执行 CLI 业务 next；不要重复提交。";

const INSTRUCTIONS: Record<InstallAgentType, string> = {
 hermes: "保持真实 hermes Agent Type；按当前实际宿主呈现官方链接，未知显示能力如实保留。沿同一 launcher、Backend 与 ITPAY_STATE_DIR 恢复，不切换身份或重置额度。",
 dot: "使用真实 dot 类型；云端执行位置与用户显示端分别判断。展示官方可点击链接，二维码可用时增强展示；浏览器打开不等于用户已看到。后续保持同一 launcher、Backend 和 ITPAY_STATE_DIR。",
 muse: "使用真实 muse 类型；保留宿主原生批准，不用聊天同意替代。云端可写目录不等于跨会话持久，显示能力未知时如实报告；沿同一 launcher、Backend 和 ITPAY_STATE_DIR 恢复原任务。",
  "codex-desktop": "在 Codex Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "codex-cli": "在 Codex CLI 中始终传这个 Agent Type；付款交接只应显示在用户可见终端。",
  "claude-code-desktop": "在 Claude Code Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "claude-code-cli": "在 Claude Code CLI 中始终传这个 Agent Type；付款交接只应显示在用户可见终端。",
  workbuddy: "在 WorkBuddy 中始终传这个 Agent Type。设备状态写入需要宿主允许的持久化权限；仅沿宿主正式流程请求权限，用户拒绝时停止。保留同一 CLI launcher，不切换 Node、不删除 identity；错误时只按实际返回的原因与恢复动作处理。Checkout 返回已渲染的付款 Card Link 和 present_files action；原样执行一次 action 打开 handoff.url，不要检查本地二维码文件。",
  zcode: "在 ZCode 中始终传这个 Agent Type。Checkout 或授权返回 handoff.url 后，立即用 ZCode 内置浏览器打开；不要只粘贴文字链接或重建二维码。只有内置浏览器不可用时才展示同一个可点击链接。",
  "doubao-work": "在豆包工作中始终传这个 Agent Type。Checkout 或授权返回后，同时展示 handoff.url 和 handoff.qr_image_url 两个有标签的官方入口；优先让用户在手机上直接打开链接，二维码供保存或另一台设备扫码。",
  "kimi-code": "保持 kimi-code Agent Type，使用标准 CLI 命令和终端付款交接；不要切换到其他平台身份。",
  openclaw: "保持 openclaw Agent Type；每个展示命令都从当前可信会话上下文显式传 --host，IM 入口同时传 --target。Telegram 使用返回的原生 message action，其他入口展示标准二维码和付款链接。",
};

export function runInstall(target: string | undefined, options: InstallOptions = {}): void {
  if (!target || target === "list") {
    const agentTypes = INSTALL_AGENT_TYPES.map(installDefinition);
    writeCommandEnvelope({
      status: "install_targets",
      result: { agent_types: agentTypes },
      instruction: "识别当前真实运行平台，从 result.agent_types 选择对应 agent_type，并由 Agent 自行运行 itpay setup --agent-type <agent_type> --json；不要让用户运行命令，也不要临时更换 Agent Type。",
      next: null,
      recovery: [{ command: "itpay docs show install-and-setup", reason: "查看安装与环境说明" }],
    }, {
      ...options,
      plainResult: agentTypes.map((item) => `${item.agent_type}: ${item.default_host ?? "explicit --host required"}`),
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
      ...installDefinition(normalized),
      default_api: DEFAULT_BASE_URL,
    },
    instruction: INSTRUCTIONS[normalized] + (normalized.startsWith("codex-") ? ` ${CODEX_WAIT_GUIDANCE}` : ""),
    next: {
      command: `itpay --agent-type ${normalized} setup --json`,
      reason: "准备当前宿主并确认设备与账号状态",
    },
    recovery: [],
  }, options);
}

export function isInstallAgentType(value: string): value is InstallAgentType {
  return (INSTALL_AGENT_TYPES as readonly string[]).includes(value);
}

function installDefinition(agentType: InstallAgentType): {
  agent_type: InstallAgentType;
  default_host: ReturnType<typeof defaultHostForAgentType> | null;
  host_required?: true;
  native_hosts?: ["telegram"];
} {
  if (agentType === "openclaw") {
    return { agent_type: agentType, default_host: null, host_required: true, native_hosts: ["telegram"] };
  }
  return { agent_type: agentType, default_host: defaultHostForAgentType(agentType) ?? null };
}
