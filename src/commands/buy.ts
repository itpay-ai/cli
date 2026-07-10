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
import { dispatchInteractionRequest } from "../render/interaction.js";
import type { RenderInteractionRequest, RenderPlan } from "../render/plan.js";
import type { OutputSink } from "../render/sink.js";
import { ensureIdeImageAttach, readFileAsDataURL } from "../render/ide.js";
import { buildAgentChatHandoff, type AgentChatHandoff } from "../render/markdown.js";
import type { Cart, PaymentIntent, SSEEvent } from "../client/types.js";

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
}

export interface BuyJSONOutput {
  kind: string;
  checkout_id: string;
  checkout_url: string;
  display_token: string;
  qr_payload: string;
  qr_png_url?: string;
  checkout_status: string;
  service_executions?: Array<{
    service_execution_id: string;
    service_capability_id?: string;
    title?: string;
  }>;
  payment_intent_id?: string;
  payment_status?: string;
  payment_action?: { qr_image_url?: string; mobile_wallet_url?: string };
  wait_status?: "verified" | "timeout" | "skipped";
  next?: string;
  // IDE image attach — local file the agent must read back into the
  // IDE chat window so the human can scan the QR. Without rendering
  // this PNG in-chat the order is not considered successful.
  brand_qr_local_path?: string;
  brand_qr_mirrors?: string[];
  brand_qr_stable_name?: string;
  brand_qr_mime_type?: string;
  brand_qr_data_url?: string;
  brand_qr_caption?: string;
  brand_qr_status?: "downloaded" | "failed" | "disabled" | "fallback";
  brand_qr_error?: string;
  brand_qr_must_render_reason?: string;
  brand_qr_render_action?: "agent_must_read_local_path_into_ide_chat";
  agent_action?: AgentChatHandoff;
}

export type BuyResult =
  | {
      kind: "interaction_requested";
      interactionRequest: RenderInteractionRequest;
    }
  | {
      kind: "checkout_rendered";
      plan: RenderPlan;
      checkoutID: string;
      displayToken: string;
      json?: BuyJSONOutput;
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
  if (!options.cartID && snap.items.length === 0) {
    throw new Error("cart is empty; add an item with `itpay cart add` first");
  }

  const missingContactFields = findMissingContactFields(options.contact, options.requiredContactFields ?? []);
  if (missingContactFields.length > 0) {
    const interactionRequest = buildMissingContactInteractionRequest(missingContactFields);
    await dispatchInteractionRequest(options.host, interactionRequest, {
      ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return {
      kind: "interaction_requested",
      interactionRequest,
    };
  }

  let cart: Cart;
  if (options.cartID) {
    cart = await backend.getCart(options.cartID);
  } else {
    const request = options.cartSession.toCreateCartRequest();
    request.client_context = {
      host: options.host,
      target: options.target,
      agent_device_id: options.cartSession.ensureAgentDeviceID(config.agentDeviceID),
    };
    const agentDeviceID = options.cartSession.ensureAgentDeviceID(config.agentDeviceID);
    request.agent_device_id = agentDeviceID;
    cart = await backend.createCart(request);
  }

  const checkoutRequest = {
    cart_id: cart.cart_id,
    client_reference_id: options.clientReferenceID ?? await operationID(config, `checkout.create:${cart.cart_id}`),
    ...(options.contact ? { delivery_contact: options.contact } : {}),
  };
  const checkout = await backend.createCheckout(checkoutRequest);

  options.cartSession.rememberCheckout({
    cartID: cart.cart_id,
    checkoutID: checkout.checkout.checkout_id,
    displayToken: checkout.display_token,
    checkoutURL: tokenizedCheckoutURL(checkout.checkout_url, checkout.display_token, checkout.qr_payload),
  });

  const checkoutID = checkout.checkout.checkout_id;
  const displayToken = checkout.display_token;
  const checkoutURL = tokenizedCheckoutURL(checkout.checkout_url, displayToken, checkout.qr_payload);

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
      await operationID(config, `payment.intent:${checkoutID}:${method}`),
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
  };
  if (checkout.qr_png_url) planInput.qrPNGURL = checkout.qr_png_url;
  if (paymentIntent) {
    planInput.paymentIntentID = paymentIntent.payment_intent_id;
    planInput.paymentMethod = paymentIntent.payment_method_type;
    planInput.paymentStatus = paymentIntent.status;
  }
  const plan = buildCheckoutQRPlan(planInput);

  // --- Download brand QR for IDE image attach (every output mode) ---
  await ensureIdeImageAttach(plan, {
    enabled: config.ideImageAttach,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  // --- Output ---
  if (options.jsonOutput) {
    const jsonInput: JSONOutputInput = {
      checkout: { ...checkout, checkout_url: checkoutURL },
      cart,
      waitStatus,
      plan,
    };
    if (paymentIntent) {
      jsonInput.paymentIntent = paymentIntent;
    }
    if (plan.ideImageAttach) {
      jsonInput.ideImageAttach = {
        localPath: plan.ideImageAttach.localPath,
        mirrors: plan.ideImageAttach.mirrors,
        mimeType: plan.ideImageAttach.mimeType,
        ...(plan.ideImageAttach.caption ? { caption: plan.ideImageAttach.caption } : {}),
        mustRenderReason: plan.ideImageAttach.mustRenderReason,
        status: plan.ideImageAttach.status,
        ...(plan.ideImageAttach.error ? { error: plan.ideImageAttach.error } : {}),
      };
    }
    const json = buildJSONOutput(jsonInput);
    (options.output ?? ((line: string) => process.stdout.write(line + "\n")))(
      JSON.stringify(json, null, 2) + "\n",
    );
    return {
      kind: "checkout_rendered",
      plan,
      checkoutID,
      displayToken,
      json,
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

// --- JSON output builder ---

interface JSONOutputInput {
  checkout: { checkout: { checkout_id: string; status: string; amount_minor: number; currency: string }; checkout_url: string; display_token: string; qr_payload: string; qr_png_url?: string };
  cart?: Cart;
  paymentIntent?: PaymentIntent | undefined;
  waitStatus: "verified" | "timeout" | "skipped";
  plan?: RenderPlan;
  ideImageAttach?: {
    localPath: string;
    mirrors: string[];
    mimeType: string;
    caption?: string;
    mustRenderReason: string;
    status: "downloaded" | "failed" | "disabled" | "fallback";
    error?: string;
  };
}

export function buildJSONOutput(input: JSONOutputInput): BuyJSONOutput {
  const output: BuyJSONOutput = {
    kind: "checkout_created",
    checkout_id: input.checkout.checkout.checkout_id,
    checkout_url: input.checkout.checkout_url,
    display_token: input.checkout.display_token,
    qr_payload: input.checkout.qr_payload,
    checkout_status: input.checkout.checkout.status,
    wait_status: input.waitStatus,
  };
  if (input.checkout.qr_png_url) {
    output.qr_png_url = input.checkout.qr_png_url;
  }
  const serviceExecutions = input.cart?.items
    .filter((item) => item.service_execution_id)
    .map((item) => ({
      service_execution_id: item.service_execution_id as string,
      ...(item.service_capability_id ? { service_capability_id: item.service_capability_id } : {}),
      ...(item.title ? { title: item.title } : {}),
    }));
  if (serviceExecutions && serviceExecutions.length > 0) {
    output.service_executions = serviceExecutions;
  }
  if (input.paymentIntent) {
    output.payment_intent_id = input.paymentIntent.payment_intent_id;
    output.payment_status = input.paymentIntent.status;
    if (input.paymentIntent.action) {
      const pa: { qr_image_url?: string; mobile_wallet_url?: string } = {};
      if (input.paymentIntent.action.qr_image_url) pa.qr_image_url = input.paymentIntent.action.qr_image_url;
      if (input.paymentIntent.action.mobile_wallet_url) pa.mobile_wallet_url = input.paymentIntent.action.mobile_wallet_url;
      output.payment_action = pa;
    }
    output.kind = "payment_handoff_required";
  }
  if (input.waitStatus === "verified") {
    output.kind = "payment_verified";
  }
  if (input.ideImageAttach) {
    output.brand_qr_status = input.ideImageAttach.status;
    if (input.ideImageAttach.localPath) {
      output.brand_qr_local_path = input.ideImageAttach.localPath;
      const dataURL = readFileAsDataURL(input.ideImageAttach.localPath, input.ideImageAttach.mimeType);
      if (dataURL) output.brand_qr_data_url = dataURL;
      const stableName = input.ideImageAttach.localPath.split("/").pop();
      if (stableName) output.brand_qr_stable_name = stableName;
    }
    if (input.ideImageAttach.mirrors.length > 0) {
      output.brand_qr_mirrors = [...input.ideImageAttach.mirrors];
    }
    output.brand_qr_mime_type = input.ideImageAttach.mimeType;
    if (input.ideImageAttach.caption) output.brand_qr_caption = input.ideImageAttach.caption;
    if (input.ideImageAttach.error) output.brand_qr_error = input.ideImageAttach.error;
    output.brand_qr_must_render_reason = input.ideImageAttach.mustRenderReason;
    output.brand_qr_render_action = "agent_must_read_local_path_into_ide_chat";
  }
  output.next = input.waitStatus === "verified"
    ? "itpay orders"
    : `itpay checkout --id ${input.checkout.checkout.checkout_id} --token ${input.checkout.display_token}`;
  if (input.plan) output.agent_action = buildAgentChatHandoff(input.plan);
  return output;
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
}): RenderPlan {
  const summary = `Scan the QR or open ${input.checkoutURL} to start the human checkout flow.`;
  const isPayment = input.paymentIntentID != null;
  const afterCommand = isPayment
    ? `itpay checkout --id ${input.checkoutID} --token ${input.displayToken}`
    : `itpay checkout --id ${input.checkoutID} --token ${input.displayToken}`;

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

export function buildMissingContactInteractionRequest(fields: ContactField[]): RenderInteractionRequest {
  return {
    kind: "input",
    id: "collect_delivery_contact",
    title: "Collect buyer contact",
    prompt: "Before creating the checkout, ask the buyer to provide the missing contact details.",
    fields: fields.map((field) => ({
      id: field,
      label: field === "email" ? "Email" : "Phone number",
      inputType: field === "email" ? "email" : "phone",
      required: true,
      placeholder: field === "email" ? "buyer@example.com" : "+86 138...",
      description: field === "email" ? "Used for receipts or delivery follow-up." : "Used when the order requires buyer verification.",
    })),
    submitLabel: "Submit contact",
  };
}

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
