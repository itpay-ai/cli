// Reads one canonical Checkout presentation. This command never creates a
// Checkout and only prepares a payment handoff while the Checkout is pending.

import type { BackendClient } from "../client/backend.js";
import type { CheckoutPresentation } from "../client/types.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { platformKeyForHost } from "../render/plan.js";
import { renderTerminalQR } from "../render/qr.js";
import { localizeCardURL, normalizeCardLocale, type CardLocale } from "../render/locale.js";
import type { OutputSink } from "../render/sink.js";
import type { ClientHost } from "../state/client_context.js";
import { DEFAULT_BASE_URL } from "../state/config.js";
import { buildCheckoutQRPlan } from "./buy.js";
import { buildCheckoutHandoff, shouldPrepareLocalCheckoutImage } from "./checkout_handoff.js";
import { type CommandAction, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

export interface CheckoutPresentationOptions {
  checkoutID: string;
  displayToken: string;
  savedCheckoutURL?: string;
  output?: OutputSink;
  host?: ClientHost;
  baseURL?: string;
  jsonOutput?: boolean;
  agentType?: string;
  target?: string;
  locale?: CardLocale;
}

export async function runCheckoutPresentation(
  backend: BackendClient,
  options: CheckoutPresentationOptions,
): Promise<void> {
  const locale = normalizeCardLocale(options.locale);
  const presentation = await backend.getCheckoutPresentation(
    options.checkoutID,
    options.displayToken,
    locale === "en" ? locale : undefined,
  );
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

  const checkoutURL = savedCheckoutURLOrFallback(
    options.savedCheckoutURL,
    options.checkoutID,
    options.displayToken,
    checkoutPageURL(options.baseURL, options.checkoutID, options.displayToken),
  );
	const cardURL = localizeCardURL(absolutePublicURL(
		options.baseURL,
		presentation.card_url ?? checkoutCardURL(options.baseURL, options.checkoutID, options.displayToken),
	), locale);
  const qrPNGURL = absolutePublicURL(
		options.baseURL,
		presentation.card_png_url ?? presentation.qr_png_url ?? checkoutCardPNGURL(options.baseURL, options.checkoutID, options.displayToken),
	);
  const localizedPNGURL = localizeCardURL(qrPNGURL, locale);
  const nextCommand = `itpay checkout --id ${options.checkoutID} --token ${options.displayToken}${locale === "en" ? " --locale en" : ""} --json`;
  const plan = buildCheckoutQRPlan({
    host,
    checkoutID: options.checkoutID,
    checkoutURL,
    cardURL,
    displayToken: options.displayToken,
    qrPayload: checkoutURL,
    qrPNGURL: localizedPNGURL,
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
  const envelope = pendingCheckoutEnvelope(presentation, checkoutURL, plan, nextCommand, options.agentType, options.target);
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
  target?: string,
): CommandEnvelope {
  const platform = platformKeyForHost(plan.host);
	const amount = formatMoney(presentation.checkout.amount_minor, presentation.checkout.currency);
  const presentationHandoff = buildCheckoutHandoff({
    platform,
    url: plan.linkOnlyURL ?? checkoutURL,
    mobileUrl: checkoutURL,
    amount,
    plan,
    ...(agentType ? { agentType } : {}),
    ...(target ? { target } : {}),
    ...(plan.preferredQRSources[0] ? { qrImageURL: plan.preferredQRSources[0] } : {}),
    ...(plan.ideImageAttach?.status === "downloaded" && plan.ideImageAttach.localPath
      ? { localPath: plan.ideImageAttach.localPath }
      : {}),
    ...(platform === "markdown" ? { markdown: buildAgentChatHandoff(plan).markdown } : {}),
  });
  const railQuote = presentation.rail_quote;
  const railPassengersPending = presentation.checkout_details === "rail_passengers" && !presentation.rail_passengers_confirmed;
  return {
    status: "human_checkout_required",
    result: {
      checkout_id: presentation.checkout.checkout_id,
      payment: "pending",
      amount,
      ...(railQuote ? { rail_quote: {
        passengers: railQuote.passengers,
        expires_at: railQuote.expires_at,
        legs: railQuote.legs.map((leg) => ({
          train_code: leg.train_code,
          travel_date: leg.travel_date,
          route: `${leg.from} → ${leg.to}`,
          time: `${leg.departure}–${leg.arrival}`,
          seat_name: leg.seat_name,
          ...(leg.seat_preferences?.length ? { seat_preferences: leg.seat_preferences } : {}),
          ...(leg.seat_request_planned ? {
            seat_request_planned: leg.seat_request_planned,
            auto_reason: leg.auto_reason ?? "none",
          } : {}),
        })),
      } } : {}),
      ...(railPassengersPending ? { rail_passengers_confirmed: false } : {}),
    },
    handoff: presentationHandoff.handoff,
    instruction: railPassengersPending
      ? `${presentationHandoff.instruction} 请用户在受保护网页填写乘车人并确认报价；姓名、证件和手机号只在网页填写，不要贴到对话中。座位偏好仅为购票请求、购票时才提交给供应商且不保证满足；无法逐人提交的偏好将自动分配座位，以实际出票为准。`
      : presentationHandoff.instruction,
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
    instruction = "告诉用户：付款已经确认，订单已经记录，不需要再次付款；结果会在同一订单下继续准备，如果最终无法交付，可以从原订单申请退款，处理方式由内容是否已使用决定。然后只执行 next.command 读取同一笔服务；Agent 不再展示付款入口或创建新订单，也不承诺退款结果。";
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

function savedCheckoutURLOrFallback(
  savedURL: string | undefined,
  checkoutID: string,
  displayToken: string,
  fallback: string,
): string {
  if (!savedURL) {
    return fallback;
  }
  try {
    const parsed = new URL(savedURL);
    const belongsToCheckout = parsed.pathname === `/checkout/${checkoutID}`;
    const sameToken = parsed.searchParams.get("display_token") === displayToken;
    return belongsToCheckout && sameToken ? savedURL : fallback;
  } catch {
    return fallback;
  }
}

function checkoutCardURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/card?display_token=${encodeURIComponent(displayToken)}`;
}

function checkoutCardPNGURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/card.png?display_token=${encodeURIComponent(displayToken)}`;
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
