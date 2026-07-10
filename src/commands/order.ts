// Read a single V3 order by id. Supports terminal text and agent markdown output.

import type { BackendClient } from "../client/backend.js";
import { formatMoney, renderOrder } from "../render/output.js";
import { hintFor } from "../render/status.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { ensureIdeImageAttach, ideImageAttachBlock } from "../render/ide.js";
import type { RenderPlan } from "../render/plan.js";

export interface OrderOptions {
  output?: OutputSink;
  host?: string;
  baseURL?: string;
}

export async function runOrder(backend: BackendClient, orderID: string, options: OrderOptions = {}): Promise<void> {
  const out = resolveOutput(options.output);
  const order = await backend.getOrder(orderID);

  // Prepare an IDE image attach slot. Order responses usually do not
  // carry a brand QR — the previous buy already produced one. We still
  // call ensureIdeImageAttach so the disabled / failed / no-source
  // states get surfaced consistently across commands.
  const plan: RenderPlan = {
    kind: "checkout_qr",
    host: (options.host ?? "terminal") as RenderPlan["host"],
    summary: "order presentation",
    url: "",
    preferredQRSources: [],
    platform: {
      text: "order presentation",
      links: [],
      buttons: [],
      blocks: [],
    },
  };
  await ensureIdeImageAttach(plan, {
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  if (options.host === "codex" || options.host === "claude-code" || options.host === "trae") {
    out(renderOrderMarkdown(order, plan) + "\n");
  } else {
    out(renderOrder(order) + "\n");
    if (plan.ideImageAttach) {
      out(ideImageAttachBlock(plan.ideImageAttach).filter((l) => l.length > 0).join("\n") + "\n");
    }
    out(`hint: ${hintFor("order", order.status)}\n`);
  }
}

function renderOrderMarkdown(order: Awaited<ReturnType<BackendClient["getOrder"]>>, plan: RenderPlan): string {
  const lines: string[] = [];
  lines.push(`## :package: 订单 ${order.order_id}`);
  lines.push("");

  const statusEmoji = order.status === "delivered" ? ":white_check_mark:" : order.status === "refunded" ? ":arrows_counterclockwise:" : ":hourglass:";
  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 状态 | ${statusEmoji} ${order.status} |`);
  lines.push(`| 金额 | ${formatMoney(order.amount_minor, order.currency)} |`);
  lines.push(`| Checkout | \`${order.checkout_id}\``);
  if (order.paid_at) lines.push(`| 支付时间 | ${order.paid_at} |`);
  lines.push("");

  if (order.items.length > 0) {
    lines.push(`| 项目 | 数量 | 单价 |`);
    lines.push(`|------|:----:|------|`);
    for (const item of order.items) {
      lines.push(`| ${item.title} | ${item.quantity} | ${formatMoney(item.amount_minor, item.currency)} |`);
    }
    lines.push("");
  }

  if (order.delivery_artifacts.length > 0) {
    lines.push(`### :lock: 交付物`);
    lines.push("");
    for (const artifact of order.delivery_artifacts) {
      const notification = artifact.notification_status ? ` — notification:${artifact.notification_status}` : "";
      const vault = artifact.vault_artifact_id ? ` — vault:\`${artifact.vault_artifact_id}\`` : "";
      lines.push(`- \`${artifact.delivery_artifact_id}\` — ${artifact.artifact_type} — ${artifact.status}${notification}${vault}`);
      if (artifact.public_preview) lines.push(`  > ${artifact.public_preview}`);
    }
    lines.push("");
  }

  if (plan.ideImageAttach) {
    lines.push(...ideImageAttachBlock(plan.ideImageAttach));
  }

  lines.push(`> :bulb: ${hintFor("order", order.status)}`);
  return lines.join("\n");
}
