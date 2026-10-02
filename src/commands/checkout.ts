// Reads one canonical Checkout presentation. This command never creates a
// Checkout and only prepares a payment handoff while the Checkout is pending.

import type { BackendClient } from "../client/backend.js";
import type { CheckoutPresentation } from "../client/types.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { platformKeyForHost } from "../render/plan.js";
import { renderTerminalQR } from "../render/qr.js";
import { localizeCardURL, normalizeCardLocale, type CardLocale } from "../render/locale.js";
import { openInSystemBrowser, type BrowserDispatch } from "../render/browser.js";
import type { OutputSink } from "../render/sink.js";
import { hostCapabilities, normalizeViewer, type ClientHost, type ViewerDevice } from "../state/client_context.js";
import { DEFAULT_BASE_URL } from "../state/config.js";
import { buildCheckoutQRPlan } from "./buy.js";
import { buildCheckoutHandoff, shouldPrepareLocalCheckoutImage } from "./checkout_handoff.js";
import { CommandContractError, plainValueLines, type CommandAction, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { resolvePresentation, resolveRelay, type PresentationRoute } from "./presentation.js";

export type PresentMethod = "auto" | "browser" | "image" | "link" | "none";

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
  // W5 presentation/relay controls (spec 03 §6). Defaults never open a
  // browser and never send a message; JSON output stays a plan.
  present?: PresentMethod;
  noOpen?: boolean;
  viewer?: ViewerDevice;
  relayOption?: string;
  confirmRelay?: boolean;
  requestKey?: string;
  relayStatus?: string;
}

export async function runCheckoutPresentation(
  backend: BackendClient,
  options: CheckoutPresentationOptions,
): Promise<void> {
  const present = options.present as string | undefined;
  if (present !== undefined && !["auto", "browser", "image", "link", "none"].includes(present)) {
    throw new CommandContractError(
      "present_invalid",
      `--present must be one of auto|browser|image|link|none`,
      "使用支持的展示方式；未知参数已被拒绝。",
      [],
    );
  }
  const relayRequested = Boolean(options.relayOption || options.confirmRelay || options.requestKey || options.relayStatus);
  if (relayRequested && options.present && options.present !== "none") {
    throw new CommandContractError(
      "present_relay_conflict",
      "--present and --relay-* options are mutually exclusive",
      "展示和消息转发二选一；不要在同一次调用中同时开页面和发消息。",
      [],
    );
  }
  if (options.noOpen && options.present === "browser") {
    throw new CommandContractError(
      "present_conflict",
      "--present browser conflicts with --no-open",
      "--no-open 与浏览器展示冲突；改用 --present link 或 image。",
      [],
    );
  }
  if (options.relayStatus) {
    // Read-only relay status. The backend exposes no relay routes yet, so the
    // honest answer is unavailable — never a resend, never a guessed state.
    writeCommandEnvelope({
      status: "relay_unavailable",
      result: { relay_id: options.relayStatus },
      instruction: "当前 Backend 未提供消息转发状态查询；不要重发。读取原订单/Checkout 状态核对。",
      next: { command: `itpay checkout --id ${options.checkoutID} --token ${options.displayToken} --json`, reason: "读取原 Checkout 当前状态" },
      recovery: [],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return;
  }
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
    localSimulation: backend.localSimulation,
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

  // W5: deterministic presentation plan — business state first, then declared
  // capabilities. `present` is the explicit display request; without it (or
  // under --json alone) nothing opens.
  // An explicit --viewer (including "unknown") wins over the host default.
  const viewer = options.viewer ? normalizeViewer(options.viewer) : (host === "terminal" ? "desktop" : "unknown");
  const locality = ["terminal", "codex", "claude-code"].includes(host) ? "same_device" : "unknown";
  const decision = resolvePresentation({
    business: {
      commerce_policy: "allowed",
      payment_state: "unpaid",
      quote_valid: presentation.rail_quote?.expires_at
        ? Date.parse(presentation.rail_quote.expires_at) > Date.now()
        : true,
      amount_minor: presentation.checkout.amount_minor,
    },
    viewer,
    executor_locality: locality,
    capabilities: hostCapabilities(host),
    ...(explicitChoiceFor(options.present) ? { explicit_choice: explicitChoiceFor(options.present)! } : {}),
  });
  const presentationResult: Record<string, unknown> = {
    recommended: decision.recommended,
    alternatives: decision.alternatives,
    ...(decision.blocker ? { blocker: decision.blocker } : {}),
  };

  let dispatch: BrowserDispatch | { status: "not_attempted" } = { status: "not_attempted" };
  // Explicit --present browser may open even under --json (the flag IS the
  // display request); --present auto under --json stays a plan and never opens.
  const browserRequested = options.present === "browser"
    || (options.present === "auto" && !options.jsonOutput && !options.noOpen && decision.recommended === "open_system_browser");
  if (browserRequested && !options.noOpen && process.env.ITPAY_NO_BROWSER !== "1") {
    const target = decision.recommended === "open_embedded_browser" ? decision.recommended : "open_system_browser";
    dispatch = await openInSystemBrowser(checkoutURL, options.baseURL);
    presentationResult.dispatched = { route: target, observation: dispatch.status };
    // Dispatch proves the request was accepted — nothing about visibility.
    if (dispatch.status === "dispatch_accepted") {
      envelope.instruction += " 已发起在本机浏览器打开官方确认页；只有用户确认看到页面才视为已显示，没看到时改发链接。";
    } else {
      envelope.instruction += " 浏览器打开未成功；按 handoff 链接展示，不要重复尝试同一方式。";
    }
  }
  if (relayRequested) {
    presentationResult.relay = resolveRelay({
      ...(options.relayOption ? { relayOption: options.relayOption } : {}),
      ...(options.confirmRelay ? { confirmRelay: options.confirmRelay } : {}),
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      backendCapability: false,
    });
    envelope.instruction += " 消息转发当前不可用；不要声称已发送，改用现有官方入口展示。";
  }
  envelope.result = { ...envelope.result, presentation: presentationResult };
  envelope.communication = {
    schema_version: "itpay.communication.v1",
    tell: decision.communication.tell,
    wait_for: decision.communication.wait_for,
    must_convey: decision.communication.must_convey,
  };
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

function explicitChoiceFor(present: PresentMethod | undefined): PresentationRoute | undefined {
  switch (present) {
    case "browser": return "open_system_browser";
    case "link": return "show_link";
    case "image": return "show_official_image";
    default: return undefined;
  }
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
      ...(presentation.payment_deadline_at ? { payment_deadline_at: presentation.payment_deadline_at } : {}),
      ...(typeof presentation.payment_remaining_seconds === "number"
        ? { payment_remaining_seconds: presentation.payment_remaining_seconds }
        : {}),
      ...(presentation.server_now ? { server_now: presentation.server_now } : {}),
      ...(presentation.verified_sms_contact ? { verified_sms_contact: presentation.verified_sms_contact } : {}),
      ...(presentation.account_phone_option?.masked_recipient
        ? { account_phone_option: { masked_recipient: presentation.account_phone_option.masked_recipient } }
        : {}),
    },
    handoff: presentationHandoff.handoff,
    instruction: railPassengersPending
      ? `${presentationHandoff.instruction} 请用户在受保护网页填写乘车人并确认报价；姓名、证件和手机号只在网页填写，不要贴到对话中。座位偏好仅为购票请求、购票时才提交给供应商且不保证满足；无法逐人提交的偏好将自动分配座位，以实际出票为准。`
      : presentationHandoff.instruction,
    next: { command: nextCommand, reason: "展示后停止；仅用户完成操作或要求核对时读取同一 Checkout" },
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
  return plainValueLines(result);
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
