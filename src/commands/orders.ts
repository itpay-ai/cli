import type { BackendClient } from "../client/backend.js";
import { HttpError } from "../client/http.js";
import type { CLIConfig } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import { formatMoney } from "../render/output.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { CommandContractError, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";
import { accessContextInstruction, vaultAccessCommand } from "./vault.js";

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
  cursor?: string;
  agentType?: string;
  host?: ClientHost;
  target?: string;
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
    response = await backend.listAccountOrders(options.limit, options.status, config.bearerToken, options.cursor);
  } catch (error) {
    if (error instanceof HttpError && error.code === "vault_authorization_required") {
      writeCommandEnvelope({
        status: "human_authorization_required",
        result: { intent: "list_purchase_history" },
        instruction: `需要用户确认一次身份和只读权限。执行 next.command 生成官方入口；用户完成后重新运行原始 orders 命令。${accessContextInstruction(options)}`,
        next: { command: vaultAccessCommand(undefined, options), reason: "创建一次账号读取授权" },
        recovery: [],
      }, {
        ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        output: out,
        ...(options.agentType ? { agentType: options.agentType } : {}),
      });
      return;
    }
    throw error;
  }
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
    next: "items" in response && response.next_cursor
      ? { command: ordersPageCommand(response.next_cursor, options), reason: "读取下一页订单摘要" }
      : null,
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    output: out,
    ...(options.agentType ? { agentType: options.agentType } : {}),
    plainResult: orders.map((summary) => {
      return `${String(summary.order_code ?? summary.order_id)}: ${String(summary.service_title ?? "订单")} · ${String(summary.status)} · ${String(summary.amount)} · ${String(summary.paid_at ?? summary.created_at ?? "")}`;
    }),
  });
}

function ordersPageCommand(cursor: string, options: ListOrdersOptions): string {
  const parts = ["itpay", "orders", "--limit", String(options.limit)];
  if (options.status) parts.push("--status", options.status);
  parts.push("--cursor", shellArgument(cursor));
  if (options.host) parts.push("--host", options.host);
  if (options.target) parts.push("--target", shellArgument(options.target));
  parts.push("--json");
  return parts.join(" ");
}

function shellArgument(value: string): string {
  if (/^[\p{L}\p{N}._:=/-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
