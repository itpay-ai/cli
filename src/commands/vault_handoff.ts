import type { ClientHost } from "../state/client_context.js";
import { platformKeyForHost } from "../render/plan.js";
import { downloadBrandQRToTmp } from "../render/ide.js";
import { renderTerminalQR, type QRFormat } from "../render/qr.js";
import { buildWorkBuddyPresentFilesAction, isWorkBuddyPlainChat } from "./checkout_handoff.js";

const AUTH_ATTACH_REASON =
  "The human must be able to open or scan this official ItPay authorization handoff. " +
  "Render the local image in the current desktop chat; if that fails, show the unchanged official URL.";

interface VaultHandoffInput {
  agentType?: string;
  host: ClientHost;
  target?: string;
  requestID: string;
  authorizationURL: string;
  qrPNGURL?: string;
  baseURL?: string;
  imageAttachEnabled: boolean;
  fetchImpl?: typeof fetch;
  qrFormat?: QRFormat;
}

export interface VaultHandoff {
  handoff: Record<string, unknown>;
  instruction: string;
  terminalQR?: string;
}

export async function buildVaultHandoff(input: VaultHandoffInput): Promise<VaultHandoff> {
  const platform = platformKeyForHost(input.host);
  const handoff: Record<string, unknown> = { url: input.authorizationURL };

  if (isWorkBuddyPlainChat(input.agentType, platform)) {
    handoff.agent_action = buildWorkBuddyPresentFilesAction(input.authorizationURL);
    return {
      handoff,
      instruction: "向用户说明这是查看已购内容的只读授权，然后严格按 handoff.agent_action 原样执行一次。打开成功后停止等待；失败时只发送同一个 handoff.url。用户完成后重新运行最初的读取命令，不要再次创建授权请求。",
    };
  }

  if (platform === "markdown") {
    const downloaded = input.imageAttachEnabled && input.qrPNGURL
      ? await downloadBrandQRToTmp(input.qrPNGURL, "auth", input.requestID, {
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.baseURL ? { baseURL: input.baseURL } : {}),
          caption: "ItPay 已购内容授权二维码",
          mustRenderReason: AUTH_ATTACH_REASON,
        })
      : { ok: false, reason: input.imageAttachEnabled ? "authorization QR is unavailable" : "IDE image attach is disabled" };
    const localPath = downloaded.attach?.localPath;
    if (localPath) handoff.qr_local_path = localPath;
    handoff.markdown = authorizationMarkdown(input.authorizationURL, localPath);
    return {
      handoff,
      instruction: localPath
        ? "向用户说明这是当前智能体查看已购内容的只读授权，把 handoff.markdown 原样发送到当前对话，确认二维码和链接真实可见后停止。用户完成后重新运行最初的读取命令。"
        : "授权二维码未能准备为本地图片。向用户说明这是只读授权并把 handoff.markdown 原样发送到当前对话，确保其中同一个官方链接可见，然后停止；不要创建替代请求。",
    };
  }

  if (input.qrPNGURL) handoff.qr_image_url = input.qrPNGURL;
  if (input.agentType?.trim().toLowerCase() === "openclaw" && platform === "telegram" && input.target) {
    handoff.agent_action = openClawAuthorizationAction(input.authorizationURL, input.qrPNGURL, input.target);
  }
  return {
    handoff,
    instruction: platform === "terminal"
      ? "向用户说明这是查看已购内容的只读授权，在用户可见终端展示当前二维码和完整官方链接，然后停止。用户完成后重新运行最初的读取命令。"
      : "向用户说明这是查看已购内容的只读授权，把 handoff.url 和可用的 handoff.qr_image_url 实际发送到当前会话，然后停止。用户完成后重新运行最初的读取命令。",
    ...(platform === "terminal" ? { terminalQR: await renderTerminalQR(input.authorizationURL, input.qrFormat ?? "unicode") } : {}),
  };
}

function authorizationMarkdown(url: string, localPath?: string): string {
  const lines = ["### ItPay 已购内容授权"];
  if (localPath) lines.push("", `![ItPay 授权二维码](<${localPath}>)`);
  lines.push(
    "",
    `[打开 ItPay 授权页面](${url})`,
    "",
    "> 该操作只允许当前智能体在你选择的时间内查看以前购买的内容，不会购买、付款或退款。",
  );
  return lines.join("\n");
}

function openClawAuthorizationAction(url: string, qrPNGURL: string | undefined, target: string): Record<string, unknown> {
  return {
    tool: "message",
    arguments: {
      action: "send",
      channel: "telegram",
      target: target.trim().replace(/^telegram:/i, ""),
      message: "ItPay 需要你确认一次只读授权，才能查看以前购买的内容。",
      ...(qrPNGURL ? { media: qrPNGURL } : {}),
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "打开授权页面", url }] }],
      },
    },
  };
}
