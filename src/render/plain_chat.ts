// Plain-chat renderer for Discord / WhatsApp / `plain-chat` hosts.
// V1 had this fallback as `image_or_link_then_human_reply` — a short
// text block with the brand QR URL and the human-open link. No inline
// buttons, no callbacks. The human pastes the link into their own
// browser or wallet and reports back.

import type { OutputSink } from "./sink.js";
import type { RenderInteractionRequest, RenderPlan } from "./plan.js";
import { ideImageAttachBlock } from "./ide.js";

export interface PlainChatRenderOptions {
  output?: OutputSink;
}

export function renderPlainChat(plan: RenderPlan, options: PlainChatRenderOptions = {}): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const brand = plan.preferredQRSources.find((src) => src.length > 0);
  const lines: string[] = [];
  lines.push(plan.summary);
  if (plan.checkoutID) lines.push(`checkout_id: ${plan.checkoutID}`);
  if (plan.paymentIntentID) lines.push(`payment_intent_id: ${plan.paymentIntentID}`);
  lines.push(`open: ${plan.url}`);
  if (brand) lines.push(`qr_image: ${brand}`);
  if (plan.mobileWalletURL) lines.push(`wallet: ${plan.mobileWalletURL}`);
  for (const media of plan.platform.media ?? []) {
    lines.push(`image: ${media.url}`);
  }
  for (const link of plan.platform.links) {
    lines.push(`- ${link.label}: ${link.url}`);
  }
  for (const interaction of plan.platform.interactions ?? []) {
    lines.push("");
    lines.push(renderInteractionText(interaction));
  }
  if (plan.ideImageAttach) {
    lines.push("");
    for (const line of ideImageAttachBlock(plan.ideImageAttach)) {
      lines.push(line);
    }
  }
  out(lines.join("\n") + "\n");
}

export function renderPlainChatInteraction(
  request: RenderInteractionRequest,
  options: PlainChatRenderOptions = {},
): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  out(renderInteractionText(request) + "\n");
}

function renderInteractionText(request: RenderInteractionRequest): string {
  const lines = [`${request.title}`, request.prompt];
  for (const media of request.media ?? []) {
    lines.push(`image: ${media.url}`);
  }
  if (request.kind === "input") {
    for (const field of request.fields) {
      lines.push(`field ${field.id}: ${field.label} (${field.inputType}${field.required ? ", required" : ""})`);
    }
    lines.push(`reply_json: ${JSON.stringify(Object.fromEntries(request.fields.map((field) => [field.id, `<${field.inputType}>`])))}`);
    return lines.join("\n");
  }

  lines.push(`selection_mode: ${request.selectionMode ?? "single"}`);
  request.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label} [${option.id}] => ${option.value}`);
  });
  return lines.join("\n");
}
