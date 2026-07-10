// Terminal renderer for the V3 CLI.
// QR display:
//   1. Branded QR PNG from server — download + save to local file
//   2. Terminal QR — scannable ASCII QR from checkout URL (always)
// All sections MANDATORY, never skipped.

import { renderTerminalQR, writeLocalPNG, type QRFormat } from "./qr.js";
import type { OutputSink } from "./sink.js";
import type { RenderInputField, RenderInteractionRequest, RenderPlan } from "./plan.js";
import { renderInlineTerminalImage } from "./terminal_image.js";
import { ideImageAttachBlock } from "./ide.js";
import { copyFile } from "node:fs/promises";

export interface TerminalRenderOptions {
  format: QRFormat;
  qrFilePath?: string;
  isTTY: boolean;
  asciiWidth?: number;
  fetchImpl?: typeof fetch;
  output?: OutputSink;
  baseURL?: string;
}

export async function renderTerminal(plan: RenderPlan, options: TerminalRenderOptions): Promise<void> {
  const out = options.output ?? ((line: string) => process.stdout.write(line));

  const isPayment = plan.kind === "payment_qr";
  out(`\n${"━".repeat(56)}\n`);
  out(isPayment ? "  ITP 待付款\n" : "  ITP 收银台\n");
  out(`${"━".repeat(56)}\n\n`);

  // --- Order table ---
  if (plan.orderItems && plan.orderItems.length > 0) {
    out("  订单详情:\n");
    let total = 0;
    for (const item of plan.orderItems) {
      const price = fmtPrice(item.amountMinor, item.currency);
      const lineTotal = item.amountMinor * item.quantity;
      total += lineTotal;
      out(`    ${item.title}  ×${item.quantity}  ${price}\n`);
    }
    out(`    ${"─".repeat(40)}\n`);
    out(`    合计: ${fmtPrice(total, plan.orderCurrency ?? "CNY")}\n\n`);
  }

  // --- Payment info ---
  if (isPayment) {
    out(`  支付方式: ${plan.paymentMethod ?? "—"}  状态: ${plan.paymentStatus ?? "—"}\n`);
    if (plan.paymentIntentID) out(`  支付 ID:   ${plan.paymentIntentID}\n`);
    out("\n");
  }

  // --- Checkout IDs + links ---
  out(`  Checkout:   ${plan.checkoutID ?? "—"}\n`);
  out(`  URL:        ${plan.url}\n`);
  for (const link of plan.platform.links) {
    out(`  ${link.label}: ${link.url}\n`);
  }
  out("\n");

  // --- Branded QR PNG download ---
  await downloadServerQR(plan, options, out);

  // --- Terminal QR (always, from checkout URL) ---
  try {
    const ascii = await renderTerminalQR(plan.url, options.format);
    out(ascii + "\n");
  } catch {
    out("  [QR render failed]\n\n");
  }

  // --- Interactions ---
  for (const interaction of plan.platform.interactions ?? []) {
    await renderTerminalInteraction(interaction, options);
  }

  // --- After-action ---
  if (plan.afterActionCommand) {
    out(`\n  ${plan.afterActionLabel ?? "Next step:"}\n`);
    out(`  ${plan.afterActionCommand}\n`);
  }

  // --- IDE image attach (mandatory) ---
  if (plan.ideImageAttach) {
    out("\n  ── IDE 图片回显（必须执行） ──\n");
    for (const line of ideImageAttachBlock(plan.ideImageAttach)) {
      if (line === "") {
        out("\n");
      } else {
        out(`  ${line.replace(/^> ?/, "")}\n`);
      }
    }
  }
  out(`\n${"━".repeat(56)}\n`);
}

async function downloadServerQR(plan: RenderPlan, options: TerminalRenderOptions, out: OutputSink): Promise<void> {
  // Use the precomputed IDE image attach when one was attached by
  // ensureIdeImageAttach (single source of truth). This avoids writing
  // a second copy of the PNG and keeps the path the agent received
  // consistent with what the terminal prints.
  const attach = plan.ideImageAttach;
  if (attach && attach.status === "downloaded" && attach.localPath) {
    out(`  Branded QR:  ${attach.localPath}\n`);
    if (attach.mirrors.length > 0) {
      out(`  QR mirrors:  ${attach.mirrors.join(", ")}\n`);
    }
    out(`  QR PNG URL:  ${attach.source}\n`);
    out(`  Attach status: ${attach.status}\n`);
    const target = options.qrFilePath ?? attach.localPath;
    if (options.isTTY) {
      renderInlineTerminalImage(target, out);
    }
    return;
  }
  if (attach && attach.status === "failed") {
    out(`  Branded QR:  MISSING (${attach.error ?? "unknown error"})\n`);
  }
  if (attach && attach.status === "disabled") {
    out(`  Branded QR:  disabled (ITPAY_IDE_IMAGE_ATTACH=0)\n`);
  }

  // Fallback: synthesise a local QR for the terminal so the human
  // still gets a scannable image even when the backend brand PNG
  // could not be obtained.
  try {
    const localPNG = await writeLocalPNG(plan.url);
    const filePath = options.qrFilePath ?? localPNG.filePath;
    if (options.qrFilePath) {
      await copyFile(localPNG.filePath, filePath);
    }
    out(`  QR file:     ${filePath}\n`);
    if (options.isTTY) {
      renderInlineTerminalImage(filePath, out);
    }
  } catch {
    /* ignore */
  }
}

export async function renderTerminalInteraction(
  request: RenderInteractionRequest,
  options: Pick<TerminalRenderOptions, "asciiWidth" | "fetchImpl" | "isTTY" | "output">,
): Promise<void> {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  out(`\nITP INPUT REQUIRED [${request.kind}]\n`);
  out(`  title:       ${request.title}\n`);
  out(`  prompt:      ${request.prompt}\n`);
  if (request.kind === "input") {
    for (const field of request.fields) {
      out(`  field:       ${field.id} (${field.inputType}${field.required ? " required" : ""}) - ${field.label}\n`);
      if (field.placeholder) out(`  placeholder: ${field.placeholder}\n`);
      if (field.description) out(`  note:        ${field.description}\n`);
    }
    out(`  reply_json:  ${JSON.stringify(buildInputTemplate(request.fields))}\n`);
    return;
  }
  out(`  select:      ${request.selectionMode ?? "single"}\n`);
  request.options.forEach((option, index) => {
    out(`  [${index + 1}] ${option.label} -> ${option.value}\n`);
    if (option.description) out(`      ${option.description}\n`);
  });
  out(`  reply_hint:  reply with option id(s) for request ${request.id}\n`);
}

function buildInputTemplate(fields: RenderInputField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.id, `<${field.inputType}>`]));
}

function fmtPrice(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}
