import type { BackendClient } from "../client/backend.js";
import { HttpError } from "../client/http.js";
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
  let response;
  try {
    response = await backend.listAccountOrders(options.limit, options.status, config.bearerToken);
  } catch (error) {
    if (error instanceof HttpError && error.code === "vault_authorization_required") {
      writeCommandEnvelope({
        status: "human_authorization_required",
        result: { intent: "list_purchase_history" },
        instruction: "需要用户确认一次身份和只读权限。执行 next.command 生成官方入口；用户完成后重新运行原始 orders 命令。",
        next: { command: "itpay vault access --json", reason: "创建一次账号读取授权" },
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
      });
      return;
    }
    throw error;
  }
  const accountSession = "orders" in response;
  const orders: Array<Record<string, string | number>> = "orders" in response
    ? response.orders.map((order) => ({
        order_id: order.order_id,
        ...(order.order_code ? { order_code: order.order_code } : {}),
        status: order.status,
        amount: formatMoney(order.amount_minor, order.currency),
        created_at: order.created_at,
      }))
    : response.items.map((order) => ({
        order_code: order.order_code,
        service_title: order.service_title,
        ...(order.subject_label ? { subject_label: order.subject_label } : {}),
        amount: formatMoney(order.amount_minor, order.currency),
        ...(order.paid_at ? { paid_at: order.paid_at } : {}),
        status: order.order_status,
        vault_artifact_count: order.vault_artifact_count,
      }));
  const latest = orders[0];
  const envelope: CommandEnvelope = {
    status: latest ? "listed" : "no_orders",
    result: { orders, next_cursor: "items" in response ? response.next_cursor || null : null },
    instruction: latest
      ? "用编号、服务、购买对象、金额、时间、订单号和状态说明结果；不要假设第一笔就是用户要找的订单。"
      : "当前账号没有符合条件的订单；不要猜测订单或自动开始购买。",
    next: latest && accountSession && "order_id" in latest
      ? { command: `itpay order ${latest.order_id} --json`, reason: "读取网页登录账号的最新订单" }
      : null,
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    plainResult: orders.map((summary) => {
      return `${String(summary.order_code ?? summary.order_id)}: ${String(summary.service_title ?? "订单")} · ${String(summary.status)} · ${String(summary.amount)} · ${String(summary.paid_at ?? summary.created_at ?? "")}`;
    }),
  });
}
