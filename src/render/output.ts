// Terminal output helpers. No HTTP, no SDK calls — only formatting.

import type { Order, RefundRequest } from "../client/types.js";

export function formatMoney(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${currency}`;
}

export function renderOrder(order: Order): string {
  const lines: string[] = [];
  lines.push(`order ${order.order_id}`);
  lines.push(`  status:    ${order.status}`);
  lines.push(`  checkout:  ${order.checkout_id}`);
  lines.push(`  amount:    ${formatMoney(order.amount_minor, order.currency)}`);
  if (order.paid_at) {
    lines.push(`  paid_at:   ${order.paid_at}`);
  }
  if (order.items.length > 0) {
    lines.push("  items:");
    for (const item of order.items) {
      lines.push(`    - ${item.title} × ${item.quantity}`);
    }
  }
  if (order.delivery_artifacts.length > 0) {
    lines.push("  delivery_artifacts:");
    for (const artifact of order.delivery_artifacts) {
      lines.push(
        `    - ${artifact.delivery_artifact_id} ${artifact.status} type=${artifact.artifact_type} redacted=${artifact.sensitive_content_redacted}`,
      );
    }
  }
  return lines.join("\n");
}

export function renderRefund(refund: RefundRequest): string {
  return [
    `refund ${refund.refund_request_id}`,
    `  order:   ${refund.order_id}`,
    `  status:  ${refund.status}`,
    `  amount:  ${formatMoney(refund.amount_minor, refund.currency)}`,
    refund.reason ? `  reason:  ${refund.reason}` : "",
	`  access:  ${refund.access_locked ? "locked" : "available"}`,
	`  policy:  ${refund.decision_mode === "automatic" ? "automatic" : "admin review"}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
