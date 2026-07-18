// V3 `buy` flow:
//   1. validate client context (host/target)
//   2. create cart via POST /v1/carts
//   3. create checkout via POST /v1/checkouts (consumes the cart)
//   4. build a checkout_qr render plan + dispatch to host renderer
//   5. [--pay] create payment intent → render payment QR → optionally SSE wait
//   6. [--json] output JSON instead of terminal text
//
// The display token is passed to the renderer and persisted in the local cart
// session so a restarted agent can resume the same checkout.

import type { BackendClient } from "../client/backend.js";
import type { CLIConfig } from "../state/config.js";
import { operationID } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import { validateContext } from "../state/client_context.js";
import type { CartSession } from "../state/cart_session.js";
import { dispatchRender, type DispatchOptions } from "../render/index.js";
import { platformKeyForHost, type RenderPlan } from "../render/plan.js";
import type { OutputSink } from "../render/sink.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import type { Cart, PaymentIntent, SSEEvent } from "../client/types.js";
import { formatMoney } from "../render/output.js";
import { CommandContractError, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { buildCheckoutHandoff, shouldPrepareLocalCheckoutImage } from "./checkout_handoff.js";
import { qualifyItPayCommand } from "../state/agent_type.js";

export type ContactField = "email" | "phone";

export interface BuyOptions {
  cartSession: CartSession;
  cartID?: string;
  host: ClientHost;
  target?: string;
  clientReferenceID?: string;
  contact?: Record<string, unknown>;
  requiredContactFields?: ContactField[];
  qrFormat?: DispatchOptions["qrFormat"];
  qrFilePath?: string;
  isTTY?: boolean;
  output?: OutputSink;
  // test hook: allow smoke tests to inject a fetch implementation
  // for the IDE image-attach download path
  fetchImpl?: typeof fetch;
  // --pay options
  pay?: boolean;
  payMethod?: "alipay" | "wechatpay";
  noWait?: boolean;
  payTimeoutSec?: number;
  // --json
  jsonOutput?: boolean;
  agentType?: string;
}

export type BuyResult = {
  kind: "checkout_rendered";
  plan: RenderPlan;
  checkoutID: string;
  displayToken: string;
  envelope?: CommandEnvelope;
};

export async function runBuy(
  backend: BackendClient,
  config: CLIConfig,
  options: BuyOptions,
): Promise<BuyResult> {
  const err = validateContext(options.host, options.target);
  if (err) {
    throw new Error(`${err.code}: ${err.message}`);
  }

  const snap = options.cartSession.show();
  const resumableCartID = !options.cartID && snap.items.length === 0 ? snap.lastCartID : undefined;
  if (!options.cartID && !resumableCartID && snap.items.length === 0) {
    throw new CommandContractError(
      "cart_empty",
      "no local draft or canonical cart is available",
      "没有可购买的普通 Cart；从已发布目录选择项目，不要猜测 item、variant 或 offer。",
      [{ command: "itpay catalog list --json", reason: "读取已发布项目" }],
    );
  }

  const missingContactFields = findMissingContactFields(options.contact, options.requiredContactFields ?? []);
  if (missingContactFields.length > 0) {
    throw new CommandContractError(
      "missing_contact",
      `missing required contact fields: ${missingContactFields.join(", ")}`,
      `向用户询问 ${missingContactFields.join(" 和 ")}，然后在同一 buy 命令补充对应 contact 参数；禁止编造。`,
      [{ command: "itpay buy --help", reason: "查看 contact 参数" }],
    );
  }

  let cart: Cart;
  if (options.cartID || resumableCartID) {
    cart = await backend.getCart(options.cartID ?? resumableCartID!);
  } else {
    const request = options.cartSession.toCreateCartRequest();
    request.client_context = {
      host: options.host,
      target: options.target,
    };
    cart = await backend.createCart(request);
  }

  const latestLine = cart.items[cart.items.length - 1];
	options.cartSession.rememberServerCart({
    cartID: cart.cart_id,
    ...(latestLine?.cart_item_id ? { cartItemID: latestLine.cart_item_id } : {}),
    ...(latestLine?.service_execution_id ? { serviceExecutionID: latestLine.service_execution_id } : {}),
	});
	const unquotedServiceLine = cart.items.find((item) => item.service_execution_id && !item.service_quote_lock_id);
	if (unquotedServiceLine?.service_execution_id) {
		throw new CommandContractError(
			"service_quote_required",
			`cart ${cart.cart_id} contains an unquoted service-backed line`,
			"该服务项目尚未绑定 Quote Lock；回到来源 Execution 完成候选选择和报价。",
			[{ command: `itpay services next ${unquotedServiceLine.service_execution_id} --json`, reason: "读取当前合法动作" }],
		);
	}
	const idempotencyKey = await operationID(config, `checkout.create:${cart.cart_id}`);
  const checkoutRequest = {
    cart_id: cart.cart_id,
    client_reference_id: options.clientReferenceID ?? idempotencyKey,
    ...(options.contact ? { delivery_contact: options.contact } : {}),
  };
  const checkout = await backend.createCheckout(checkoutRequest, idempotencyKey);

  options.cartSession.rememberCheckout({
    checkoutID: checkout.checkout.checkout_id,
    displayToken: checkout.display_token,
    checkoutURL: tokenizedCheckoutURL(checkout.checkout_url, checkout.display_token, checkout.qr_payload),
  });

  const checkoutID = checkout.checkout.checkout_id;
  const displayToken = checkout.display_token;
  const checkoutURL = tokenizedCheckoutURL(checkout.checkout_url, displayToken, checkout.qr_payload);
  const qrPNGURL = checkout.qr_png_url ? absolutePublicURL(config.baseURL, checkout.qr_png_url) : undefined;

  const orderItems = cart.items.map((item) => ({
    title: item.title,
    quantity: item.quantity,
    amountMinor: item.amount_minor,
    currency: item.currency,
  }));

  // --- Payment flow (optional) ---
  let paymentIntent: PaymentIntent | undefined;
  let waitStatus: "verified" | "timeout" | "skipped" = "skipped";

  if (options.pay) {
    const method = options.payMethod ?? "alipay";
    paymentIntent = await backend.createPaymentIntent(
      checkoutID,
      { payment_method_type: method, display_token: displayToken },
    );

    if (!options.jsonOutput) {
      process.stdout.write("\n--- payment intent ---\n");
      process.stdout.write(`  id:     ${paymentIntent.payment_intent_id}\n`);
      process.stdout.write(`  method: ${paymentIntent.payment_method_type}\n`);
      process.stdout.write(`  status: ${paymentIntent.status}\n`);
      if (paymentIntent.action?.qr_image_url) {
        process.stdout.write(`  qr:     ${paymentIntent.action.qr_image_url}\n`);
      }
      if (paymentIntent.action?.mobile_wallet_url) {
        process.stdout.write(`  wallet: ${paymentIntent.action.mobile_wallet_url}\n`);
      }
    }

    if (!options.noWait) {
      waitStatus = await waitForPaymentSSE(backend, checkoutID, displayToken, options.payTimeoutSec ?? 120);
      if (!options.jsonOutput) {
        process.stdout.write(`  wait:    ${waitStatus}\n`);
      }
    }
  }

  // --- Build render plan (after payment if --pay) ---
  const planInput: Parameters<typeof buildCheckoutQRPlan>[0] = {
    host: options.host,
    checkoutID,
    checkoutURL,
    displayToken,
    qrPayload: checkout.qr_payload,
    nextAction: checkout.checkout.next_action,
    orderItems,
    orderCurrency: checkout.checkout.currency,
    ...(options.agentType ? { agentType: options.agentType } : {}),
  };
  if (qrPNGURL) planInput.qrPNGURL = qrPNGURL;
  if (paymentIntent) {
    planInput.paymentIntentID = paymentIntent.payment_intent_id;
    planInput.paymentMethod = paymentIntent.payment_method_type;
    planInput.paymentStatus = paymentIntent.status;
  }
  const plan = buildCheckoutQRPlan(planInput);

  // --- Download a local QR only for desktop Markdown hosts ---
  if (shouldPrepareLocalCheckoutImage(platformKeyForHost(options.host))) {
    await ensureIdeImageAttach(plan, {
      enabled: config.ideImageAttach,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  // --- Output ---
  if (options.jsonOutput) {
    const envelope = buildBuyEnvelope({
      cart,
      checkoutID,
      checkoutURL,
      displayToken,
      plan,
      waitStatus,
      ...(qrPNGURL ? { qrPNGURL } : {}),
      ...(paymentIntent ? { paymentIntent } : {}),
      ...(options.agentType ? { agentType: options.agentType } : {}),
    });
    writeCommandEnvelope(envelope, { jsonOutput: true, ...(options.output ? { output: options.output } : {}) });
    return {
      kind: "checkout_rendered",
      plan,
      checkoutID,
      displayToken,
      envelope,
    };
  }

  // Text output — always render QR for non-JSON mode
  const renderOptions: DispatchOptions = {
    host: options.host,
    isTTY: options.isTTY ?? Boolean(process.stdout.isTTY),
    ...(options.target ? { target: options.target } : {}),
    ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
    ...(options.qrFilePath ? { qrFilePath: options.qrFilePath } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    baseURL: config.baseURL,
  };
  await dispatchRender(plan, renderOptions);

  return {
    kind: "checkout_rendered",
    plan,
    checkoutID,
    displayToken,
  };
}

function buildBuyEnvelope(input: {
  cart: Cart;
  checkoutID: string;
  checkoutURL: string;
  displayToken: string;
  qrPNGURL?: string;
  plan: RenderPlan;
  paymentIntent?: PaymentIntent;
  waitStatus: "verified" | "timeout" | "skipped";
  agentType?: string;
}): CommandEnvelope {
  const verified = input.waitStatus === "verified";
  const platform = platformKeyForHost(input.plan.host);
  const amount = formatMoney(input.cart.amount_minor, input.cart.currency);
  const result: Record<string, unknown> = {
    checkout_id: input.checkoutID,
    payment: verified ? "verified" : "pending",
    amount,
    item_count: input.cart.items.length,
    ...(input.paymentIntent ? {
      payment_intent_id: input.paymentIntent.payment_intent_id,
      payment_intent_status: input.paymentIntent.status,
    } : {}),
    ...(input.waitStatus === "timeout" ? { wait_status: "timeout" } : {}),
  };
  if (verified) {
    return {
      status: "payment_event_observed",
      result,
      instruction: "已观察到付款确认事件；读取同一 Checkout 的权威完成状态，不要再次付款。",
      next: { command: `itpay checkout --id ${input.checkoutID} --token ${input.displayToken} --json`, reason: "读取订单和履约句柄" },
      recovery: [],
    };
  }
  const presentationHandoff = buildCheckoutHandoff({
    platform,
    url: input.checkoutURL,
    amount,
    ...(input.agentType ? { agentType: input.agentType } : {}),
    ...(input.qrPNGURL ? { qrImageURL: input.qrPNGURL } : {}),
    ...(input.plan.ideImageAttach?.status === "downloaded" && input.plan.ideImageAttach.localPath
      ? { localPath: input.plan.ideImageAttach.localPath }
      : {}),
    ...(platform === "markdown" ? { markdown: buildAgentChatHandoff(input.plan).markdown } : {}),
  });
  return {
    status: "human_checkout_required",
    result,
    handoff: presentationHandoff.handoff,
    instruction: presentationHandoff.instruction,
    next: { command: `itpay checkout --id ${input.checkoutID} --token ${input.displayToken} --json`, reason: "稍后查询同一笔 Checkout 状态" },
    recovery: [],
  };
}

// --- SSE wait for payment verification ---

async function waitForPaymentSSE(
  backend: BackendClient,
  checkoutID: string,
  displayToken: string,
  timeoutSec: number,
): Promise<"verified" | "timeout"> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutSec * 1000);

    backend.streamCheckoutEvents(
      checkoutID,
      displayToken,
      (event: SSEEvent) => {
        if (event.type === "payment_intent.verified") {
          clearTimeout(timeout);
          controller.abort();
          resolve("verified");
        }
      },
      controller.signal,
    ).catch(() => {
      // stream ended or aborted
    }).finally(() => {
      clearTimeout(timeout);
    });
  });
}

// --- checkout QR plan ---

export function buildCheckoutQRPlan(input: {
  host: ClientHost;
  checkoutID: string;
  checkoutURL: string;
  displayToken: string;
  qrPayload: string;
  qrPNGURL?: string;
  nextAction: string;
  orderItems?: { title: string; quantity: number; amountMinor: number; currency: string }[];
  orderCurrency?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  paymentIntentID?: string;
  agentType?: string;
}): RenderPlan {
  const summary = `Scan the QR or open ${input.checkoutURL} to start the human checkout flow.`;
  const isPayment = input.paymentIntentID != null;
  const afterCommand = qualifyItPayCommand(
    `itpay checkout --id ${input.checkoutID} --token ${input.displayToken} --json`,
    input.agentType,
  );

  const platform: RenderPlan["platform"] = {
    text: summary,
    links: [
      { label: "打开付款页面", url: input.checkoutURL },
    ],
    buttons: [
      { label: "打开收银台", kind: "url" as const, url: input.checkoutURL },
      ...(input.checkoutID
        ? [{ label: "查询 Checkout 状态", kind: "callback" as const, intent: "check_checkout_status", ref: input.checkoutID }]
        : []),
    ],
    blocks: [],
    ...(input.qrPNGURL ? { media: [{ url: input.qrPNGURL, label: "Branded QR", mimeType: "image/png" }] } : {}),
  };

  const plan: RenderPlan = {
    kind: isPayment ? "payment_qr" : "checkout_qr",
    host: input.host,
    summary,
    url: input.qrPayload,
    preferredQRSources: [input.qrPNGURL ?? input.qrPayload],
    checkoutID: input.checkoutID,
    platform,
    afterActionCommand: afterCommand,
    afterActionLabel: "扫码或点击链接完成支付后，执行以下命令查询状态：",
  };
  if (input.orderItems) plan.orderItems = input.orderItems;
  if (input.orderCurrency) plan.orderCurrency = input.orderCurrency;
  if (input.paymentMethod) plan.paymentMethod = input.paymentMethod;
  if (input.paymentStatus) plan.paymentStatus = input.paymentStatus;
  if (input.paymentIntentID) plan.paymentIntentID = input.paymentIntentID;
  return plan;
}

// --- contact field interaction ---

function findMissingContactFields(contact: Record<string, unknown> | undefined, fields: ContactField[]): ContactField[] {
  return fields.filter((field) => {
    const value = contact?.[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

function tokenizedCheckoutURL(checkoutURL: string, displayToken: string, qrPayload: string): string {
  if (qrPayload.trim().length > 0) {
    return qrPayload;
  }
  if (checkoutURL.trim().length === 0 || displayToken.trim().length === 0) {
    return checkoutURL;
  }
  try {
    const parsed = new URL(checkoutURL);
    if (!parsed.searchParams.has("display_token")) {
      parsed.searchParams.set("display_token", displayToken);
    }
    return parsed.toString();
  } catch {
    const separator = checkoutURL.includes("?") ? "&" : "?";
    return `${checkoutURL}${separator}display_token=${encodeURIComponent(displayToken)}`;
  }
}

function absolutePublicURL(baseURL: string, value: string): string {
  try {
    return new URL(value, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();
  } catch {
    return value;
  }
}
