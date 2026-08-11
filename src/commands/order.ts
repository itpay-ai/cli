import type { BackendClient } from "../client/backend.js";
import type { OrderDeliveryAccess, RefundRequest } from "../client/types.js";
import { formatMoney } from "../render/output.js";
import type { OutputSink } from "../render/sink.js";
import { type CommandAction, type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

export interface OrderOptions {
  output?: OutputSink;
  host?: string;
  jsonOutput?: boolean;
}

export async function runOrder(backend: BackendClient, orderID: string, options: OrderOptions = {}): Promise<void> {
  const order = await backend.getOrder(orderID);
  const [delivery, refundResponse] = await Promise.all([
    order.status === "delivered" ? backend.getOrderDeliveryAccess(orderID) : Promise.resolve(undefined),
    backend.listOrderRefunds(orderID),
  ]);
  const lockedRefund = refundResponse.refunds.find((refund) => refund.access_locked);
  const envelope = orderEnvelope(order, delivery, lockedRefund);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: orderPlainResult(envelope.result),
  });
}

function orderEnvelope(
  order: Awaited<ReturnType<BackendClient["getOrder"]>>,
  delivery: OrderDeliveryAccess | undefined,
  lockedRefund: RefundRequest | undefined,
): CommandEnvelope {
  const refundTerminal = lockedRefund && ["succeeded", "failed", "cancelled", "rejected"].includes(lockedRefund.status);
  let instruction = "订单状态已读取；当前没有可用交付入口。";
  let next: CommandAction | null = null;
  if (lockedRefund) {
    instruction = "先告诉用户退款处理中，原交付已按政策冻结；再读取同一退款的权威状态。不要 reveal、创建 grant、读取交付结果或重复申请退款。";
    if (!refundTerminal) {
      next = { command: `itpay refund get ${lockedRefund.refund_request_id} --json`, reason: "读取退款的服务器状态" };
    }
  } else if (delivery?.service_execution_id) {
    instruction = "先告诉用户订单已经找到并说明当前交付状态；再根据 delivery_mode 使用对应读取入口，不要从订单摘要猜测受保护内容。";
    next = { command: `itpay services next ${delivery.service_execution_id} --json`, reason: "读取交付状态" };
  } else if (order.status === "failed") {
    instruction = "先告诉用户这笔订单没有正常交付，不需要重复付款或重新下单；先检查原订单是否已有退款，再由用户决定是否申请。";
    next = { command: `itpay refund list --order ${order.order_id} --json`, reason: "检查同一订单的退款状态" };
  } else if (order.status === "refunded") {
    instruction = "先告诉用户这笔订单已经退款，原交付不可继续读取；不要再次付款或尝试恢复旧授权。";
  } else if (order.status === "cancelled") {
    instruction = "先告诉用户这笔订单已经取消，没有可继续的付款或交付；不要创建替代订单，除非用户另行提出新的购买。";
  } else if (!["delivered", "refunded", "failed", "cancelled"].includes(order.status)) {
    instruction = "先告诉用户订单仍在处理，已记录的付款和订单不需要重复创建；稍后查询同一订单，不要创建替代订单。";
    next = { command: `itpay order ${order.order_id} --json`, reason: "刷新订单状态" };
  }

  return {
    status: order.status,
    result: {
      order_id: order.order_id,
      ...(order.order_code ? { order_code: order.order_code } : {}),
      amount: formatMoney(order.amount_minor, order.currency),
      ...(delivery ? { delivery_mode: delivery.delivery_mode } : {}),
      access_locked: Boolean(lockedRefund),
      ...(delivery?.service_execution_id ? { service_execution_id: delivery.service_execution_id } : {}),
      ...(lockedRefund ? { refund: { refund_request_id: lockedRefund.refund_request_id, status: lockedRefund.status } } : {}),
    },
    instruction,
    next,
    recovery: [],
  };
}

function orderPlainResult(result: Record<string, unknown>): string[] {
  return Object.entries(result).map(([key, value]) =>
    `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}
