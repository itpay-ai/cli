// Explicit Payment Intent escape hatch. Normal buyers should use the ItPay
// Checkout page; this command exists for controlled integration recovery.

import type { BackendClient } from "../client/backend.js";
import type { PaymentIntent } from "../client/types.js";
import { formatMoney } from "../render/output.js";
import type { OutputSink } from "../render/sink.js";
import type { ClientHost } from "../state/client_context.js";
import { type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { isWorkBuddyPlainChat } from "./checkout_handoff.js";
import { platformKeyForHost } from "../render/plan.js";

export interface PayOptions {
  checkoutID: string;
  displayToken: string;
  method: "alipay" | "wechatpay";
  host: ClientHost;
  refreshAction?: boolean;
  jsonOutput?: boolean;
  output?: OutputSink;
  agentType?: string;
}

export async function runPay(backend: BackendClient, options: PayOptions): Promise<void> {
  const intent = await backend.createPaymentIntent(
    options.checkoutID,
    {
      payment_method_type: options.method,
      display_token: options.displayToken,
      ...(options.refreshAction ? { refresh_action: true } : {}),
    },
  );
  const envelope = payEnvelope(intent, options);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}

function payEnvelope(intent: PaymentIntent, options: PayOptions): CommandEnvelope {
  const terminal = ["failed", "expired", "refunded"].includes(intent.status);
  const verified = intent.status === "verified" || intent.status === "partially_refunded";
  const handoff: Record<string, unknown> = {};
  if (!terminal && !verified && intent.action?.qr_image_url) handoff.qr_image_url = intent.action.qr_image_url;
  if (!terminal && !verified && intent.action?.mobile_wallet_url) handoff.mobile_wallet_url = intent.action.mobile_wallet_url;
  const hasAction = Object.keys(handoff).length > 0;
  const amount = formatMoney(intent.amount_minor, intent.currency);
  return {
    status: verified ? "payment_verified" : terminal ? "payment_unavailable" : hasAction ? "payment_action_ready" : "payment_action_pending",
    result: {
      checkout_id: options.checkoutID,
      payment_intent_id: intent.payment_intent_id,
      payment: verified ? "verified" : intent.status,
      amount,
    },
    ...(hasAction ? { handoff } : {}),
    instruction: payInstruction(
      options,
      verified,
      terminal,
      hasAction,
      Boolean(handoff.qr_image_url),
      Boolean(handoff.mobile_wallet_url),
      amount,
    ),
    next: {
      command: `itpay checkout --id ${options.checkoutID} --token ${options.displayToken} --json`,
      reason: verified ? "读取权威订单和履约状态" : "读取同一 Checkout 的权威付款状态",
    },
    recovery: [],
  };
}

function payInstruction(
  options: PayOptions,
  verified: boolean,
  terminal: boolean,
  hasAction: boolean,
  hasQR: boolean,
  hasWallet: boolean,
  amount: string,
): string {
  if (verified) return "付款已确认；不要再次展示付款动作，继续读取同一 Checkout。";
  if (terminal) return "Payment Intent 已终止；不要自行创建替代付款，回到同一 Checkout 读取恢复方向。";
  if (!hasAction) return "Payment Intent 尚未返回可展示动作；不要猜测渠道链接，回到同一 Checkout 查询。";
  const platform = platformKeyForHost(options.host);
  if (isWorkBuddyPlainChat(options.agentType, platform)) {
    if (hasQR && hasWallet) return `这是受控逃生入口。读取 handoff.qr_image_url 的完整字符串，原样作为 files 数组唯一元素调用 present_files({ files: ["<完整 qr_image_url>"] })；右侧预览打开后说明金额 ${amount}、发送 handoff.mobile_wallet_url 并停止等待。如果 present_files 失败，发送 handoff.qr_image_url 和 handoff.mobile_wallet_url 并说明二维码预览未打开，然后停止。不要立即查询、创建替代 Checkout 或 Payment Intent。`;
    if (hasQR) return `这是受控逃生入口。读取 handoff.qr_image_url 的完整字符串，原样作为 files 数组唯一元素调用 present_files({ files: ["<完整 qr_image_url>"] })；右侧预览打开后说明金额 ${amount} 并停止等待。如果 present_files 失败，把 handoff.qr_image_url 作为可点击链接发送给用户并说明二维码预览未打开，然后停止。不要立即查询、创建替代 Checkout 或 Payment Intent。`;
    return `这是受控逃生入口。说明金额 ${amount}，把 handoff.mobile_wallet_url 作为可点击链接发送给用户，然后停止等待；不要立即查询、创建替代 Checkout 或 Payment Intent。`;
  }
  if (options.host === "codex" || options.host === "claude-code") return "这是受控逃生入口；把 handoff 中的二维码或钱包链接实际发到当前桌面对话，然后停止等待。";
  if (options.host === "terminal") return "这是受控逃生入口；只在用户可见终端展示 handoff，然后停止等待。";
  return "这是受控逃生入口；把 handoff 中的二维码或钱包链接发送到当前会话，然后停止等待。";
}
