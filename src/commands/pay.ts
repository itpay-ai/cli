// Explicit Payment Intent escape hatch. Normal buyers should use the ItPay
// Checkout page; this command exists for controlled integration recovery.

import type { BackendClient } from "../client/backend.js";
import type { PaymentIntent } from "../client/types.js";
import { formatMoney } from "../render/output.js";
import type { OutputSink } from "../render/sink.js";
import type { ClientHost } from "../state/client_context.js";
import { type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { buildWorkBuddyPresentFilesAction, isWorkBuddyPlainChat } from "./checkout_handoff.js";
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
  const workBuddyAction = isWorkBuddyPlainChat(options.agentType, platformKeyForHost(options.host));
  if (!terminal && !verified && workBuddyAction) {
    const url = intent.action?.mobile_wallet_url ?? intent.action?.qr_image_url;
    if (url) {
      handoff.url = url;
      handoff.agent_action = buildWorkBuddyPresentFilesAction(url);
    }
  } else {
    if (!terminal && !verified && intent.action?.qr_image_url) handoff.qr_image_url = intent.action.qr_image_url;
    if (!terminal && !verified && intent.action?.mobile_wallet_url) handoff.mobile_wallet_url = intent.action.mobile_wallet_url;
  }
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
  amount: string,
): string {
  if (verified) return "付款已确认；不要再次展示付款动作，继续读取同一 Checkout。";
  if (terminal) return "Payment Intent 已终止；不要自行创建替代付款，回到同一 Checkout 读取恢复方向。";
  if (!hasAction) return "Payment Intent 尚未返回可展示动作；不要猜测渠道链接，回到同一 Checkout 查询。";
  const platform = platformKeyForHost(options.host);
  if (isWorkBuddyPlainChat(options.agentType, platform)) {
    return `这是受控逃生入口。立即严格按 handoff.agent_action 原样执行一次，在右侧打开 handoff.url；确认工具调用成功后说明金额 ${amount} 并停止等待。若工具失败，只发送原始 handoff.url，报告未自动打开并停止。不要用 present_files 打开本地文件或二维码 PNG，不要立即查询、创建替代 Checkout 或 Payment Intent。`;
  }
  if (options.host === "codex" || options.host === "claude-code") return "这是受控逃生入口；把 handoff 中的二维码或钱包链接实际发到当前桌面对话，然后停止等待。";
  if (options.host === "terminal") return "这是受控逃生入口；只在用户可见终端展示 handoff，然后停止等待。";
  return "这是受控逃生入口；把 handoff 中的二维码或钱包链接发送到当前会话，然后停止等待。";
}
