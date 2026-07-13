// CLI cart commands. Server cart is canonical for agent purchase/free-trial
// flows; local cart helpers are kept for explicit local draft compatibility.

import type { CartSession, LocalCartItem } from "../state/cart_session.js";
import type { BackendClient } from "../client/backend.js";
import type { Cart } from "../client/types.js";
import type { CLIConfig } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import { formatMoney } from "../render/output.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { writeCommandEnvelope, type CommandEnvelope } from "./guidance.js";

export interface CartAddOptions {
  catalogItemID: string;
  catalogVariantID: string;
  offerID: string;
  quantity: number;
  input?: Record<string, unknown>;
  output?: OutputSink;
  jsonOutput?: boolean;
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
  const envelope: CommandEnvelope = {
    status: "added_local",
    result: {
      catalog_item_id: item.catalogItemID,
      catalog_variant_id: item.catalogVariantID,
      offer_id: item.offerID,
      quantity: item.quantity,
    },
    instruction: "仅写入本地兼容草稿，未验证目录、价格或服务合同；不要把它当作 canonical Cart。",
    next: { command: "itpay cart show --local", reason: "检查本地草稿" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
  });
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
  };
  const cart = options.session.lastCartID
      ? await options.backend.addCartItem(options.session.lastCartID, {
        ...item,
        client_context: clientContext,
      })
    : await options.backend.createCart({
        currency: options.config.checkoutCurrency,
        client_context: clientContext,
        items: [item],
      });
  const line = cart.items[cart.items.length - 1];
  options.session.rememberServerCart({
    cartID: cart.cart_id,
    ...(line?.cart_item_id ? { cartItemID: line.cart_item_id } : {}),
    ...(line?.service_execution_id ? { serviceExecutionID: line.service_execution_id } : {}),
  });
  if (!line?.cart_item_id) {
    throw new Error("backend did not return the added cart item");
  }
  const serviceExecutionID = line.service_execution_id;
  const envelope: CommandEnvelope = {
    status: "added",
    result: {
      cart_id: cart.cart_id,
      cart_item_id: line.cart_item_id,
      ...(serviceExecutionID ? { service_execution_id: serviceExecutionID } : {}),
      title: line.title,
      amount: formatMoney(line.amount_minor, line.currency),
    },
    instruction: serviceExecutionID
      ? "服务型项目已创建 Service Execution；先读取其当前步骤，不要直接进入普通 buy。"
      : "普通项目已加入 canonical Cart；先检查购物车，再创建 Checkout。",
    next: serviceExecutionID
      ? { command: `itpay services next ${serviceExecutionID} --json`, reason: "读取服务执行的当前步骤" }
      : { command: "itpay cart next --json", reason: "检查 canonical Cart" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    plainResult: Object.entries(envelope.result).map(([key, value]) => `${key}: ${String(value)}`),
  });
  return cart;
}

export interface CartRemoveOptions {
  catalogVariantID: string;
  offerID: string;
  output?: OutputSink;
  jsonOutput?: boolean;
}

export function runCartRemove(session: CartSession, options: CartRemoveOptions): void {
  const out = resolveOutput(options.output);
  session.remove(options.catalogVariantID, options.offerID);
  writeCommandEnvelope({
    status: "removed_local",
    result: {
      catalog_variant_id: options.catalogVariantID,
      offer_id: options.offerID,
    },
    instruction: "本地兼容草稿已更新；这不代表任何 canonical Cart 或 Service Execution 已变更。",
    next: { command: "itpay cart show --local --json", reason: "检查剩余本地草稿" },
    recovery: [],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
  });
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
  const latestLine = cart.items[cart.items.length - 1];
  session.rememberServerCart({
    cartID: cart.cart_id,
    ...(latestLine?.cart_item_id ? { cartItemID: latestLine.cart_item_id } : {}),
    ...(latestLine?.service_execution_id ? { serviceExecutionID: latestLine.service_execution_id } : {}),
  });
  const envelope: CommandEnvelope = {
    status: "removed",
    result: {
      cart_id: cart.cart_id,
      cart_item_id: lineID,
      remaining_item_count: cart.items.length,
    },
    instruction: "canonical Cart 已更新；被删除的最后一个 service-backed line 对应执行会由服务端一致性事务取消。",
    next: { command: "itpay cart next --json", reason: "检查剩余内容" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
  });
  return cart;
}

export interface CartShowOptions {
  output?: OutputSink;
  jsonOutput?: boolean;
}

export function runCartShow(session: CartSession, options: CartShowOptions = {}): void {
  const snap = session.show();
  const items = snap.items.map((item) => ({
    catalog_item_id: item.catalogItemID,
    catalog_variant_id: item.catalogVariantID,
    offer_id: item.offerID,
    quantity: item.quantity,
  }));
  const envelope: CommandEnvelope = {
    status: items.length > 0 ? "shown_local" : "local_empty",
    result: { currency: snap.currency, items },
    instruction: items.length > 0
      ? "这是未验证的本地兼容草稿，只能用于明确的普通商品流程；不要把它当作 canonical Cart。"
      : "本地兼容草稿为空；从已发布目录重新选择项目。",
    next: items.length > 0
      ? { command: "itpay buy --json", reason: "将普通本地草稿提交为 canonical Cart" }
      : { command: "itpay catalog list --json", reason: "读取已发布目录" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}

export async function runCartShowServer(backend: BackendClient, session: CartSession, options: CartShowOptions = {}): Promise<Cart | undefined> {
  if (!session.lastCartID) {
    writeCommandEnvelope({
      status: "cart_handle_missing",
      result: {},
      instruction: "本地没有 canonical Cart 句柄；不要把本地草稿默认为服务端 Cart。",
      next: { command: "itpay catalog list --json", reason: "读取已发布目录" },
      recovery: [{ command: "itpay cart show --local --json", reason: "仅在明确需要时检查本地兼容草稿" }],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return undefined;
  }
  const cart = await backend.getCart(session.lastCartID);
  const items = cart.items.map((item) => ({
    ...(item.cart_item_id ? { cart_item_id: item.cart_item_id } : {}),
    title: item.title,
    quantity: item.quantity,
    ...(item.service_execution_id ? { service_execution_id: item.service_execution_id } : {}),
  }));
  const envelope: CommandEnvelope = {
    status: "shown",
    result: {
      cart_id: cart.cart_id,
      status: cart.status,
      amount: formatMoney(cart.amount_minor, cart.currency),
      items,
    },
    instruction: items.length > 0
      ? "使用 line 或 execution 句柄继续；不要使用内部 quote lock ID。"
      : "canonical Cart 当前为空；从已发布目录选择项目。",
    next: items.length > 0
      ? { command: "itpay cart next --json", reason: "取得当前首选动作" }
      : { command: "itpay catalog list --json", reason: "读取已发布目录" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [
      `cart_id: ${cart.cart_id}`,
      `state: ${cart.status}`,
      `amount: ${formatMoney(cart.amount_minor, cart.currency)}`,
      ...items.map((item) => `${item.cart_item_id ?? "line"}: ${item.title} x${item.quantity}${item.service_execution_id ? ` service_execution=${item.service_execution_id}` : ""}`),
    ],
  });
  return cart;
}

export interface CartClearOptions {
  output?: OutputSink;
  jsonOutput?: boolean;
}

export function runCartClear(session: CartSession, options: CartClearOptions = {}): void {
  session.clear();
  const envelope: CommandEnvelope = {
    status: "cleared_local",
    result: { server_abandoned: false, local_state_cleared: true },
    instruction: "仅清除了本地草稿和恢复句柄；Backend Cart、Checkout 和 Service Execution 均未改变。",
    next: { command: "itpay catalog list --json", reason: "仅在用户提出新需求时重新选择" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}

export async function runCartAbandonServer(
  backend: BackendClient,
  session: CartSession,
  options: CartClearOptions = {},
): Promise<Cart | undefined> {
  if (!session.lastCartID) {
    writeCommandEnvelope({
      status: "cart_handle_missing",
      result: {},
      instruction: "本地没有 canonical Cart 句柄；未修改任何 Backend 或本地资源。",
      next: { command: "itpay next --json", reason: "检查其他可恢复句柄" },
      recovery: [{ command: "itpay cart clear --local --json", reason: "仅在明确放弃本地草稿和句柄时执行" }],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return undefined;
  }
  const cart = await backend.abandonCart(session.lastCartID);
  session.clear();
  const envelope: CommandEnvelope = {
    status: "abandoned",
    result: { cart_id: cart.cart_id, server_abandoned: true },
    instruction: "canonical Cart 已放弃；Backend 已在同一事务中软删除 active lines，并取消其未付款 Service Execution。",
    next: { command: "itpay catalog list --json", reason: "仅在用户提出新需求时重新选择" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [`cart_id: ${cart.cart_id}`, "server_abandoned: true"],
  });
  return cart;
}

export async function runCartNext(
  backend: BackendClient,
  session: CartSession,
  options: CartShowOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  if (!session.lastCartID) {
    writeCartNextEnvelope({
      status: "cart_handle_missing",
      result: {},
      instruction: "本地没有 canonical Cart 句柄；先恢复已有资源，不要创建重复 Cart。",
      next: { command: "itpay next --json", reason: "检查其他可恢复句柄" },
      recovery: [{ command: "itpay services list --json", reason: "从服务端恢复当前设备的执行" }],
    }, options);
    return;
  }

  const cart = await backend.getCart(session.lastCartID);
  const serviceLine = [...cart.items].reverse().find((item) => item.service_execution_id);
  let envelope: CommandEnvelope;
  if (serviceLine?.service_execution_id) {
    envelope = {
      status: "action_available",
      result: {
        cart_id: cart.cart_id,
        cart_status: cart.status,
        service_execution_id: serviceLine.service_execution_id,
      },
      instruction: "该 Cart 包含 service-backed line；继续 Service Execution，不要从 Cart 猜 capability。",
      next: {
        command: `itpay services next ${serviceLine.service_execution_id} --json`,
        reason: "读取服务端最新执行状态",
      },
      recovery: [],
    };
  } else if (cart.items.length === 0) {
    envelope = {
      status: "cart_empty",
      result: { cart_id: cart.cart_id, cart_status: cart.status },
      instruction: "Cart 当前为空；先读取已发布目录，不要猜测 item 或 variant。",
      next: { command: "itpay catalog list --json", reason: "选择已发布服务" },
      recovery: [],
    };
  } else {
    envelope = {
      status: "action_available",
      result: {
        cart_id: cart.cart_id,
        cart_status: cart.status,
        item_count: cart.items.length,
        amount_minor: cart.amount_minor,
        currency: cart.currency,
      },
      instruction: "该 Cart 是普通购买流程；使用同一 Cart 创建 Checkout，不要重复添加商品。",
      next: { command: `itpay buy --cart ${cart.cart_id} --json`, reason: "继续 canonical Cart 结算" },
      recovery: [],
    };
  }
  writeCartNextEnvelope(envelope, options);
}

function writeCartNextEnvelope(envelope: CommandEnvelope, options: CartShowOptions & { jsonOutput?: boolean }): void {
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}
