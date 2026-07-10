// CLI cart commands. Server cart is canonical for agent purchase/free-trial
// flows; local cart helpers are kept for explicit local draft compatibility.

import type { CartSession, LocalCartItem } from "../state/cart_session.js";
import type { BackendClient } from "../client/backend.js";
import { HttpError } from "../client/http.js";
import type { Cart, ServiceExecutionReadModel } from "../client/types.js";
import type { CLIConfig } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { attachAgentGuidance, buildCartGuidance, printAgentGuidance } from "./guidance.js";

export interface CartAddOptions {
  catalogItemID: string;
  catalogVariantID: string;
  offerID: string;
  quantity: number;
  input?: Record<string, unknown>;
  output?: OutputSink;
}

export function runCartAdd(session: CartSession, options: CartAddOptions): void {
  const out = resolveOutput(options.output);
  const item: LocalCartItem = {
    catalogItemID: options.catalogItemID,
    catalogVariantID: options.catalogVariantID,
    offerID: options.offerID,
    quantity: options.quantity,
    ...(options.input ? { input: options.input } : {}),
  };
  session.add(item);
  out(`added ${item.quantity} × variant=${item.catalogVariantID} offer=${item.offerID} to cart\n`);
}

export interface ServerCartAddOptions extends CartAddOptions {
  host: ClientHost;
  target?: string;
  jsonOutput?: boolean;
  backend: BackendClient;
  config: CLIConfig;
  session: CartSession;
  output?: OutputSink;
}

export async function runCartAddServer(options: ServerCartAddOptions): Promise<Cart> {
  const out = resolveOutput(options.output);
  const agentDeviceID = options.session.ensureAgentDeviceID(options.config.agentDeviceID);
  const item = {
    catalog_item_id: options.catalogItemID,
    catalog_variant_id: options.catalogVariantID,
    offer_id: options.offerID,
    quantity: options.quantity,
    ...(options.input ? { input: options.input } : {}),
  };
  const clientContext = {
    host: options.host,
    ...(options.target ? { target: options.target } : {}),
    agent_device_id: agentDeviceID,
  };
  const cart = options.session.lastCartID
    ? await options.backend.addCartItem(options.session.lastCartID, {
        ...item,
        agent_device_id: agentDeviceID,
        client_context: clientContext,
      })
    : await options.backend.createCart({
        currency: options.config.checkoutCurrency,
        agent_device_id: agentDeviceID,
        client_context: clientContext,
        items: [item],
      });
  const line = cart.items[cart.items.length - 1];
  options.session.rememberServerCart({
    cartID: cart.cart_id,
    ...(line?.cart_item_id ? { cartItemID: line.cart_item_id } : {}),
    ...(line?.service_execution_id ? { serviceExecutionID: line.service_execution_id } : {}),
    agentDeviceID,
  });
  const serviceModel = line?.service_execution_id
    ? await getServiceReadModel(options.backend, line.service_execution_id)
    : undefined;
  const guidance = buildCartGuidance(cart, serviceModel);
  if (options.jsonOutput) {
    out(JSON.stringify(attachAgentGuidance(cart, guidance), null, 2) + "\n");
  } else {
    out(`cart: ${cart.cart_id}\n`);
    if (line?.cart_item_id) out(`line: ${line.cart_item_id}\n`);
    if (line?.service_execution_id) out(`service execution: ${line.service_execution_id}\n`);
    printAgentGuidance(guidance, options.output);
  }
  return cart;
}

export interface CartRemoveOptions {
  catalogVariantID: string;
  offerID: string;
  output?: OutputSink;
}

export function runCartRemove(session: CartSession, options: CartRemoveOptions): void {
  const out = resolveOutput(options.output);
  session.remove(options.catalogVariantID, options.offerID);
  out(`removed variant=${options.catalogVariantID} offer=${options.offerID}\n`);
}

export async function runCartRemoveServer(
  backend: BackendClient,
  session: CartSession,
  cartItemID: string | undefined,
  options: CartShowOptions = {},
): Promise<Cart> {
  const out = resolveOutput(options.output);
  const cartID = session.lastCartID;
  if (!cartID) {
    throw new Error("no canonical server cart is remembered; use --local for local draft removal");
  }
  const lineID = cartItemID || session.lastCartItemID;
  if (!lineID) {
    throw new Error("missing cart item id; pass --line <cart_item_id>");
  }
  const cart = await backend.removeCartItem(cartID, lineID);
  out(`removed line=${lineID} from cart=${cart.cart_id}\n`);
  out(`cart ${cart.cart_id} (${cart.status}, ${cart.amount_minor} ${cart.currency})\n`);
  return cart;
}

export interface CartShowOptions {
  output?: OutputSink;
}

export function runCartShow(session: CartSession, options: CartShowOptions = {}): void {
  const out = resolveOutput(options.output);
  const snap = session.show();
  out(`cart (currency=${snap.currency})\n`);
  if (snap.items.length === 0) {
    out("  (empty)\n");
    return;
  }
  for (const item of snap.items) {
    out(
      `  - ${item.quantity} × variant=${item.catalogVariantID} offer=${item.offerID}` +
        (item.input ? ` input=${JSON.stringify(item.input)}` : "") +
        "\n",
    );
  }
  if (snap.lastCheckoutID) {
    out(`last checkout: ${snap.lastCheckoutID}\n`);
    if (snap.lastCheckoutURL) {
      out(`checkout url:  ${snap.lastCheckoutURL}\n`);
    }
  }
}

export async function runCartShowServer(backend: BackendClient, session: CartSession, options: CartShowOptions = {}): Promise<Cart | undefined> {
  const out = resolveOutput(options.output);
  if (!session.lastCartID) {
    runCartShow(session, options);
    return undefined;
  }
  const cart = await backend.getCart(session.lastCartID);
  out(`cart ${cart.cart_id} (${cart.status}, ${cart.amount_minor} ${cart.currency})\n`);
  if (cart.items.length === 0) {
    out("  (empty)\n");
    return cart;
  }
  for (const item of cart.items) {
    out(`  - ${item.quantity} × ${item.title} ${item.amount_minor} ${item.currency}\n`);
    out(`    line=${item.cart_item_id ?? ""} variant=${item.catalog_variant_id ?? ""} offer=${item.offer_id ?? ""}\n`);
    if (item.service_execution_id) {
      out(`    service_execution=${item.service_execution_id} next_action=${item.next_action ?? ""} checkout_required=${String(item.checkout_required ?? false)}\n`);
    }
    if (item.service_quote_lock_id) {
      out(`    service_quote_lock=${item.service_quote_lock_id}\n`);
    }
  }
  const serviceModel = await getServiceReadModelForCart(backend, cart);
  printAgentGuidance(buildCartGuidance(cart, serviceModel), options.output);
  return cart;
}

export interface CartClearOptions {
  output?: OutputSink;
}

export function runCartClear(session: CartSession, options: CartClearOptions = {}): void {
  const out = resolveOutput(options.output);
  session.clear();
  out("cart cleared\n");
}

export async function runCartAbandonServer(
  backend: BackendClient,
  session: CartSession,
  options: CartClearOptions = {},
): Promise<Cart | undefined> {
  const out = resolveOutput(options.output);
  if (!session.lastCartID) {
    runCartClear(session, options);
    return undefined;
  }
  let cart: Cart;
  try {
    cart = await backend.abandonCart(session.lastCartID);
  } catch (error) {
    if (error instanceof HttpError && (error.code === "cart_item_locked" || error.status === 409)) {
      const cartID = session.lastCartID;
      session.clear();
      out(`cart local handle cleared; server cart ${cartID} is locked by quote/checkout\n`);
      return undefined;
    }
    throw error;
  }
  session.clear();
  out(`cart abandoned: ${cart.cart_id}\n`);
  return cart;
}

export async function runCartNext(
  backend: BackendClient,
  session: CartSession,
  options: CartShowOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const out = resolveOutput(options.output);
  if (session.lastCartID) {
    const cart = await backend.getCart(session.lastCartID);
    const guidance = buildCartGuidance(cart, await getServiceReadModelForCart(backend, cart));
    if (options.jsonOutput) {
      out(JSON.stringify(guidance, null, 2) + "\n");
    } else {
      printAgentGuidance(guidance, options.output);
    }
    return;
  }
  const snap = session.show();
  if (snap.lastServiceExecutionID) {
    const model = await getServiceReadModel(backend, snap.lastServiceExecutionID);
    const guidance = model
      ? buildCartGuidance({
          cart_id: snap.lastCartID ?? "<unknown_cart>",
          status: "unknown",
          amount_minor: 0,
          currency: snap.currency,
          items: [{
            title: "Service Execution",
            quantity: 1,
            amount_minor: 0,
            currency: snap.currency,
            service_execution_id: snap.lastServiceExecutionID,
          }],
        }, model)
      : buildCartGuidance({
          cart_id: snap.lastCartID ?? "<unknown_cart>",
          status: "unknown",
          amount_minor: 0,
          currency: snap.currency,
          items: [{
            title: "Service Execution",
            quantity: 1,
            amount_minor: 0,
            currency: snap.currency,
            service_execution_id: snap.lastServiceExecutionID,
          }],
        });
    if (options.jsonOutput) {
      out(JSON.stringify(guidance, null, 2) + "\n");
    } else {
      printAgentGuidance(guidance, options.output);
    }
    return;
  }
  if (snap.lastCheckoutID && snap.lastDisplayToken) {
    const guidance = {
      kind: "checkout_handle",
      summary: `checkout ${snap.lastCheckoutID}: continue human checkout`,
      state: { checkout_id: snap.lastCheckoutID },
      next_actions: [{
        id: "open_checkout",
        label: "Open saved checkout presentation",
        command: `itpay checkout --id ${snap.lastCheckoutID} --token ${snap.lastDisplayToken}`,
        requires_human: true,
      }],
      recovery: [],
    };
    if (options.jsonOutput) {
      out(JSON.stringify(guidance, null, 2) + "\n");
    } else {
      printAgentGuidance(guidance, options.output);
    }
    return;
  }
  const guidance = {
    kind: "no_active_handle",
    summary: "no active server cart, service execution, or checkout handle remembered",
    state: {},
    next_actions: [{
      id: "browse_catalog",
      label: "Browse services",
      command: "itpay catalog list",
    }],
    recovery: [],
  };
  if (options.jsonOutput) {
    out(JSON.stringify(guidance, null, 2) + "\n");
  } else {
    printAgentGuidance(guidance, options.output);
  }
}

async function getServiceReadModelForCart(backend: BackendClient, cart: Cart): Promise<ServiceExecutionReadModel | undefined> {
  const serviceExecutionID = [...cart.items].reverse().find((item) => item.service_execution_id)?.service_execution_id;
  return serviceExecutionID ? getServiceReadModel(backend, serviceExecutionID) : undefined;
}

async function getServiceReadModel(backend: BackendClient, serviceExecutionID: string): Promise<ServiceExecutionReadModel | undefined> {
  try {
    return await backend.getServiceExecution(serviceExecutionID);
  } catch {
    return undefined;
  }
}
