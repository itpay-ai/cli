// Reads one canonical Checkout presentation. This command never creates a
// Checkout and only prepares a payment handoff while the Checkout is pending.

import type { BackendClient } from "../client/backend.js";
import type { CheckoutPresentation } from "../client/types.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { platformKeyForHost } from "../render/plan.js";
import { renderTerminalQR } from "../render/qr.js";
import type { OutputSink } from "../render/sink.js";
import type { ClientHost } from "../state/client_context.js";
import { DEFAULT_BASE_URL } from "../state/config.js";
import { buildCheckoutQRPlan } from "./buy.js";
import { buildCheckoutHandoff, shouldPrepareLocalCheckoutImage } from "./checkout_handoff.js";
import { type CommandAction, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

export interface CheckoutPresentationOptions {
  checkoutID: string;
  displayToken: string;
  output?: OutputSink;
  host?: ClientHost;
  baseURL?: string;
  jsonOutput?: boolean;
  agentType?: string;
}

export async function runCheckoutPresentation(
  backend: BackendClient,
  options: CheckoutPresentationOptions,
): Promise<void> {
  const presentation = await backend.getCheckoutPresentation(options.checkoutID, options.displayToken);
  const host = options.host ?? "terminal";
  if (!checkoutNeedsHumanHandoff(presentation.checkout.status)) {
    const envelope = terminalCheckoutEnvelope(presentation);
    writeCommandEnvelope(envelope, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
      plainResult: checkoutPlainResult(envelope.result),
    });
    return;
  }

  const checkoutURL = checkoutPageURL(options.baseURL, options.checkoutID, options.displayToken);
  const qrPNGURL = absolutePublicURL(
		options.baseURL,
		presentation.qr_png_url ?? checkoutQRPNGURL(options.baseURL, options.checkoutID, options.displayToken),
	);
  const nextCommand = `itpay checkout --id ${options.checkoutID} --token ${options.displayToken} --json`;
  const plan = buildCheckoutQRPlan({
    host,
    checkoutID: options.checkoutID,
    checkoutURL,
    displayToken: options.displayToken,
    qrPayload: checkoutURL,
    qrPNGURL,
    nextAction: presentation.checkout.next_action,
    orderItems: presentation.items.map((item) => ({
      title: item.title,
      quantity: item.quantity,
      amountMinor: item.amount_minor,
      currency: item.currency,
    })),
    orderCurrency: presentation.checkout.currency,
    ...(options.agentType ? { agentType: options.agentType } : {}),
  });
  const platform = platformKeyForHost(host);
  if (shouldPrepareLocalCheckoutImage(platform)) {
    await ensureIdeImageAttach(plan, {
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }
  const envelope = pendingCheckoutEnvelope(presentation, checkoutURL, plan, nextCommand, options.agentType);
  const plainResult = checkoutPlainResult(envelope.result);
  if (!options.jsonOutput && platformKeyForHost(host) === "terminal") {
    plainResult.push("qr:", await renderTerminalQR(checkoutURL, "terminal"));
  }
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult,
  });
}

function pendingCheckoutEnvelope(
  presentation: CheckoutPresentation,
  checkoutURL: string,
  plan: ReturnType<typeof buildCheckoutQRPlan>,
  nextCommand: string,
  agentType?: string,
): CommandEnvelope {
  const platform = platformKeyForHost(plan.host);
	const amount = formatMoney(presentation.checkout.amount_minor, presentation.checkout.currency);
  const presentationHandoff = buildCheckoutHandoff({
    platform,
    url: checkoutURL,
    amount,
    ...(agentType ? { agentType } : {}),
    ...(plan.preferredQRSources[0] ? { qrImageURL: plan.preferredQRSources[0] } : {}),
    ...(plan.ideImageAttach?.status === "downloaded" && plan.ideImageAttach.localPath
      ? { localPath: plan.ideImageAttach.localPath }
      : {}),
    ...(platform === "markdown" ? { markdown: buildAgentChatHandoff(plan).markdown } : {}),
  });
  return {
    status: "human_checkout_required",
    result: {
      checkout_id: presentation.checkout.checkout_id,
      payment: "pending",
      amount,
    },
    handoff: presentationHandoff.handoff,
    instruction: presentationHandoff.instruction,
    next: { command: nextCommand, reason: "稍后只查询同一 Checkout" },
    recovery: [],
  };
}

function terminalCheckoutEnvelope(presentation: CheckoutPresentation): CommandEnvelope {
  const checkout = presentation.checkout;
  const serviceExecutionIDs = [...new Set(
    presentation.items.map((item) => item.service_execution_id).filter((id): id is string => Boolean(id)),
  )];
  const payment = checkout.status === "refunded" ? "refunded"
    : checkout.status === "payment_succeeded" || checkout.status === "completed" ? "verified"
      : checkout.status;
  const result: Record<string, unknown> = {
    checkout_id: checkout.checkout_id,
    payment,
    ...(presentation.completed_order_id ? { order_id: presentation.completed_order_id } : {}),
    ...(serviceExecutionIDs.length === 1 ? { service_execution_id: serviceExecutionIDs[0] } : {}),
    ...(serviceExecutionIDs.length > 1 ? { service_execution_ids: serviceExecutionIDs } : {}),
  };
  let status = checkout.status;
  let instruction = "Checkout 已结束；不要再次展示付款二维码。";
  let next: CommandAction | null = null;
  const recovery: CommandAction[] = [];
  if (payment === "verified") {
    status = "completed";
    instruction = "Backend 已确认这笔付款。不要再次展示付款入口，不要调用 pay，不要创建新 Checkout 或 Execution。现在只执行 next.command，读取同一 Execution 的履约结果。";
    next = serviceExecutionIDs.length === 1
      ? { command: `itpay services next ${serviceExecutionIDs[0]} --json`, reason: "读取同一笔已付款 Service Execution" }
      : presentation.completed_order_id
        ? { command: `itpay order ${presentation.completed_order_id}`, reason: "读取已创建订单" }
        : { command: "itpay orders", reason: "恢复已付款订单" };
  } else if (checkout.status === "refunded") {
    instruction = "该 Checkout 已退款，不要再次付款或展示二维码。";
    if (presentation.completed_order_id) next = { command: `itpay order ${presentation.completed_order_id}`, reason: "读取订单与退款状态" };
  } else if (checkout.status === "failed" || checkout.status === "expired") {
    instruction = "该 Checkout 已失效；不要继续使用当前付款入口。";
    if (serviceExecutionIDs.length === 1) {
      recovery.push({ command: `itpay services next ${serviceExecutionIDs[0]} --json`, reason: "由服务端决定是否可恢复 Checkout" });
    }
  }
  return { status, result, instruction, next, recovery };
}

function checkoutNeedsHumanHandoff(status: string): boolean {
  return !new Set(["payment_succeeded", "completed", "failed", "expired", "refunded"]).has(status);
}

function checkoutPlainResult(result: Record<string, unknown>): string[] {
  return Object.entries(result).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function checkoutPageURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/checkout/${encodeURIComponent(checkoutID)}?display_token=${encodeURIComponent(displayToken)}`;
}

function checkoutQRPNGURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/qr.png?display_token=${encodeURIComponent(displayToken)}`;
}

function publicRoot(baseURL: string | undefined): string {
  return (baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

function absolutePublicURL(baseURL: string | undefined, value: string): string {
	try {
		const root = publicRoot(baseURL);
		return new URL(value, `${root}/`).toString();
	} catch {
		return value;
	}
}
