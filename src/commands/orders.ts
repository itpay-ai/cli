import type { BackendClient } from "../client/backend.js";
import type { CLIConfig } from "../state/config.js";
import { formatMoney } from "../render/output.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { CommandContractError, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

const ORDER_STATUSES = new Set([
  "pending_payment",
  "paid",
  "delivery_pending",
  "delivered",
  "failed",
  "partially_refunded",
  "refunded",
  "cancelled",
]);

export interface ListOrdersOptions {
  limit: number;
  status?: string;
  output?: OutputSink;
  jsonOutput?: boolean;
}

export async function runListOrders(
  backend: BackendClient,
  config: CLIConfig,
  options: ListOrdersOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new CommandContractError(
      "limit_invalid",
      "--limit must be an integer from 1 to 100",
      "使用 1 到 100 的整数 limit；本次未读取订单列表。",
      [{ command: "itpay orders --limit 20 --json", reason: "使用默认上限重试" }],
    );
  }
  if (options.status && !ORDER_STATUSES.has(options.status)) {
    throw new CommandContractError(
      "order_status_invalid",
      `unsupported order status: ${options.status}`,
      "使用订单合同中的有效 status；本次未读取订单列表。",
      [{ command: "itpay orders --limit 20 --json", reason: "移除状态过滤后重试" }],
    );
  }
  if (!config.bearerToken) {
    throw new CommandContractError(
      "session_required",
      "account-scoped Buyer session is required",
      "订单历史只对网页登录账号开放；不要伪造 Buyer token。Agent 可改为恢复当前设备绑定的 Service Execution。",
      [{ command: "itpay services list --json", reason: "恢复当前 Agent 设备可见的执行" }],
    );
  }
  const response = await backend.listAccountOrders(options.limit, options.status, config.bearerToken);
  const orders = response.orders.map((order) => ({
    order_id: order.order_id,
    ...(order.order_code ? { order_code: order.order_code } : {}),
    status: order.status,
    amount: formatMoney(order.amount_minor, order.currency),
    created_at: order.created_at,
  }));
  const latest = orders[0];
  const envelope: CommandEnvelope = {
    status: latest ? "listed" : "no_orders",
    result: { orders },
    instruction: latest
      ? "结果按最新到最旧排列；按页面编号、时间和状态选择目标订单，不要假设第一笔就是当前任务。"
      : "当前账号没有符合条件的订单；不要猜测订单 ID。",
    next: latest
      ? { command: `itpay order ${latest.order_id} --json`, reason: "默认读取最新订单" }
      : null,
    recovery: latest ? [] : [{ command: "itpay services list --json", reason: "恢复当前 Agent 设备可见的执行" }],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    plainResult: orders.map((order) =>
      `${order.order_code ?? order.order_id}: ${order.status} ${order.amount} created=${order.created_at}`,
    ),
  });
}
