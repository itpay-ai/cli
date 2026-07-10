// Reads the canonical V3 checkout presentation. Requires both checkout_id
// and the checkout-scoped display_token. Supports terminal and agent markdown.

import type { BackendClient } from "../client/backend.js";
import { formatMoney } from "../render/output.js";
import { hintFor } from "../render/status.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { ensureIdeImageAttach, ideImageAttachBlock } from "../render/ide.js";
import type { RenderPlan } from "../render/plan.js";
import { DEFAULT_BASE_URL } from "../state/config.js";

export interface CheckoutPresentationOptions {
  checkoutID: string;
  displayToken: string;
  output?: OutputSink;
  host?: string;
  baseURL?: string;
}

export async function runCheckoutPresentation(
  backend: BackendClient,
  options: CheckoutPresentationOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  const presentation = await backend.getCheckoutPresentation(options.checkoutID, options.displayToken);

  const checkoutURL = checkoutPageURL(options.baseURL, options.checkoutID, options.displayToken);
  const qrPNGURL = presentation.qr_png_url ?? checkoutQRPNGURL(options.baseURL, options.checkoutID, options.displayToken);

  const plan: RenderPlan = {
    kind: "checkout_qr",
    host: (options.host ?? "terminal") as RenderPlan["host"],
    summary: "checkout presentation",
    url: checkoutURL,
    preferredQRSources: [qrPNGURL],
    platform: {
      text: "checkout presentation",
      links: [{ label: "打开付款页面", url: checkoutURL }],
      buttons: [],
      blocks: [],
    },
  };
  await ensureIdeImageAttach(plan, {
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  if (options.host === "codex" || options.host === "claude-code" || options.host === "trae") {
    out(renderCheckoutMarkdown(presentation, plan) + "\n");
  } else {
    out(renderCheckoutText(presentation) + "\n");
    if (plan.ideImageAttach) {
      out(ideImageAttachBlock(plan.ideImageAttach).filter((l) => l.length > 0).join("\n") + "\n");
    }
    out(`hint: ${hintFor("checkout", presentation.checkout.status)}\n`);
  }
}

function renderCheckoutText(presentation: Awaited<ReturnType<BackendClient["getCheckoutPresentation"]>>): string {
  const lines: string[] = [];
  const c = presentation.checkout;
  lines.push(`checkout ${c.checkout_id}`);
  lines.push(`  status:      ${c.status}`);
  lines.push(`  next_action: ${c.next_action}`);
  lines.push(`  amount:      ${formatMoney(c.amount_minor, c.currency)}`);
  lines.push(`  buyer:       ${presentation.buyer_session.state}`);
  if (presentation.items.length > 0) {
    lines.push("  items:");
    for (const item of presentation.items) {
      lines.push(`    - ${item.title} × ${item.quantity} (${formatMoney(item.amount_minor, item.currency)})`);
    }
  }
  if (presentation.payment_intents.length > 0) {
    lines.push("  payment_intents:");
    for (const intent of presentation.payment_intents) {
      lines.push(`    - ${intent.payment_intent_id} ${intent.status} (${intent.payment_method_type}, ${formatMoney(intent.amount_minor, intent.currency)})`);
    }
  }
  return lines.join("\n");
}

function renderCheckoutMarkdown(presentation: Awaited<ReturnType<BackendClient["getCheckoutPresentation"]>>, plan: RenderPlan): string {
  const c = presentation.checkout;
  const lines: string[] = [];
  lines.push(`## :mag: Checkout ${c.checkout_id}`);
  lines.push("");

  lines.push(`| 字段 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 状态 | ${c.status} |`);
  lines.push(`| 操作 | ${c.next_action} |`);
  lines.push(`| 金额 | ${formatMoney(c.amount_minor, c.currency)} |`);
  lines.push(`| 买家 | ${presentation.buyer_session.state} |`);
  lines.push("");

  if (presentation.items.length > 0) {
    lines.push(`| 项目 | 数量 | 单价 |`);
    lines.push(`|------|:----:|------|`);
    for (const item of presentation.items) {
      lines.push(`| ${item.title} | ${item.quantity} | ${formatMoney(item.amount_minor, item.currency)} |`);
    }
    lines.push("");
  }

  if (presentation.payment_intents.length > 0) {
    lines.push(`### :credit_card: 支付`);
    lines.push("");
    for (const intent of presentation.payment_intents) {
      lines.push(`- \`${intent.payment_intent_id}\` — ${intent.payment_method_type} — ${intent.status} — ${formatMoney(intent.amount_minor, intent.currency)}`);
    }
    lines.push("");
  }

  if (plan.ideImageAttach) {
    lines.push(...ideImageAttachBlock(plan.ideImageAttach));
  }

  lines.push(`> :bulb: ${hintFor("checkout", c.status)}`);
  return lines.join("\n");
}

function checkoutPageURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/checkout/${encodeURIComponent(checkoutID)}?display_token=${encodeURIComponent(displayToken)}`;
}

function checkoutQRPNGURL(baseURL: string | undefined, checkoutID: string, displayToken: string): string {
  const root = publicRoot(baseURL);
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/qr.png?display_token=${encodeURIComponent(displayToken)}`;
}

function publicRoot(baseURL: string | undefined): string {
  return (baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}
