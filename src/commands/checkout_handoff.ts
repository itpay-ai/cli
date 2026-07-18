import { platformKeyForHost } from "../render/plan.js";

export type CheckoutPlatform = ReturnType<typeof platformKeyForHost>;

interface CheckoutHandoffInput {
  agentType?: string;
  platform: CheckoutPlatform;
  url: string;
  qrImageURL?: string;
  localPath?: string;
  markdown?: string;
  amount: string;
}

export function shouldPrepareLocalCheckoutImage(platform: CheckoutPlatform): boolean {
  return platform === "markdown";
}

export function isWorkBuddyPlainChat(agentType: string | undefined, platform: CheckoutPlatform): boolean {
  return agentType?.trim().toLowerCase() === "workbuddy" && platform === "plain_chat";
}

export function buildCheckoutHandoff(input: CheckoutHandoffInput): {
  handoff: Record<string, unknown>;
  instruction: string;
} {
  const handoff: Record<string, unknown> = { url: input.url };
  if (input.platform === "markdown") {
    if (input.localPath) handoff.qr_local_path = input.localPath;
    if (input.markdown) handoff.markdown = input.markdown;
  } else if (input.platform === "plain_chat" && input.qrImageURL) {
    handoff.qr_image_url = input.qrImageURL;
  }

  return {
    handoff,
    instruction: checkoutHandoffInstruction(input.agentType, input.platform, input.amount, Boolean(input.qrImageURL)),
  };
}

function checkoutHandoffInstruction(
  agentType: string | undefined,
  platform: CheckoutPlatform,
  amount: string,
  hasQRImage: boolean,
): string {
  if (isWorkBuddyPlainChat(agentType, platform)) {
    if (!hasQRImage) {
      return `Backend 尚未确认付款，且本次没有返回可展示的二维码。向用户说明金额 ${amount} 并发送 handoff.url，然后停止等待。不要调用 present_files，不要检查本地文件，不要下载或重建二维码，不要调用 pay，不要创建新 Checkout、Payment Intent 或 Execution。只有用户明确表示已付款或要求查询状态时，才执行 next.command；用户的话不是付款成功证明。`;
    }
    return `Backend 尚未确认付款。读取 handoff.qr_image_url 的完整字符串，原样作为 files 数组唯一元素调用 present_files({ files: ["<完整 qr_image_url>"] })；确认右侧二维码预览已打开后，向用户说明金额 ${amount} 并发送 handoff.url，然后停止等待。如果 present_files 失败，只发送 handoff.url 并说明二维码预览未打开，然后停止。不要检查本地文件，不要下载或重建二维码，不要调用 pay，不要创建新 Checkout、Payment Intent 或 Execution。只有用户明确表示已付款或要求查询状态时，才执行 next.command；用户的话不是付款成功证明。`;
  }
  if (platform === "markdown") {
    return `Backend 尚未确认付款。把 handoff.markdown 原样发送到当前桌面对话，确认二维码、付款链接和金额 ${amount} 均已实际对用户可见，然后停止等待。不要创建新 Checkout、Payment Intent 或 Execution；只有用户明确表示已付款或要求查询状态时，才执行 next.command；用户的话不是付款成功证明。`;
  }
  if (platform === "terminal") {
    return `Backend 尚未确认付款。在用户可见终端展示当前 Checkout 的二维码、handoff.url 和金额 ${amount}，然后停止等待。不要创建新 Checkout、Payment Intent 或 Execution；只有用户明确表示已付款或要求查询状态时，才执行 next.command；用户的话不是付款成功证明。`;
  }
  return `Backend 尚未确认付款。把 handoff.url 和可用的 handoff.qr_image_url 实际发送到当前会话，说明金额 ${amount}，然后停止等待。不要创建新 Checkout、Payment Intent 或 Execution；只有用户明确表示已付款或要求查询状态时，才执行 next.command；用户的话不是付款成功证明。`;
}
