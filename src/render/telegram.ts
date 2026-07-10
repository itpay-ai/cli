// Telegram renderer for the V3 CLI. Builds an `openclaw_message`
// command payload the agent can hand to the OpenClaw gateway, plus
// a structured `presentation.blocks` for native inline buttons.
//
// V1 only rendered `auth_qr` and `payment_qr`; V3 also has
// `checkout_qr` (a buyer scans a branded QR from the CLI/agent to
// land on the human checkout page). We emit the same button shape
// for all three kinds but adjust the button intent.

import type { OutputSink } from "./sink.js";
import type { RenderButton, RenderInteractionRequest, RenderPlan, RenderSelectorOption } from "./plan.js";
import { ideImageAttachBlock } from "./ide.js";

export interface TelegramRenderOptions {
  target: string; // chat id
  output?: OutputSink;
}

function buttonsFor(plan: RenderPlan): RenderButton[] {
  if (plan.kind === "payment_qr" && plan.paymentIntentID) {
    return [
      { label: "支付遇到问题 / 刷新", kind: "callback", intent: "refresh_payment_qr", ref: plan.paymentIntentID },
      { label: "我已付款，查询状态", kind: "callback", intent: "check_payment_status", ref: plan.paymentIntentID },
    ];
  }
  if (plan.kind === "auth_qr" && plan.checkoutID) {
    return [
      { label: "打开授权页面", kind: "url", url: plan.url },
      { label: "查询授权状态", kind: "callback", intent: "check_checkout_status", ref: plan.checkoutID },
    ];
  }
  // checkout_qr
  return [
    { label: "打开 ItPay 收银台", kind: "url", url: plan.url },
    ...(plan.checkoutID
      ? [{ label: "查询 Checkout 状态", kind: "callback" as const, intent: "check_checkout_status", ref: plan.checkoutID }]
      : []),
  ];
}

function format(plan: RenderPlan): "photo_text_inline_buttons" | "text_inline_buttons" {
  return plan.kind === "payment_qr" ? "photo_text_inline_buttons" : "text_inline_buttons";
}

export function renderTelegram(plan: RenderPlan, options: TelegramRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const buttons = buttonsFor(plan);
  const media = collectTelegramMedia(plan);

  const text =
    plan.kind === "payment_qr"
      ? `ItPay payment QR — ${plan.summary}`
      : plan.kind === "auth_qr"
        ? `ItPay auth required — ${plan.summary}`
        : `ItPay checkout QR — ${plan.summary}`;

  const presentation = {
    format: format(plan),
    media,
    text,
    links: plan.platform.links,
    buttons,
    interactions: plan.platform.interactions ?? [],
    blocks: [
      { type: "text", text },
      ...(media.length > 0 ? [{ type: "image", url: media[0]!.url }] : []),
      { type: "buttons", buttons },
    ],
    ...(plan.ideImageAttach
      ? {
          ide_image_attach: {
            status: plan.ideImageAttach.status,
            local_path: plan.ideImageAttach.localPath,
            mirrors: plan.ideImageAttach.mirrors,
            mime_type: plan.ideImageAttach.mimeType,
            source: plan.ideImageAttach.source,
            ...(plan.ideImageAttach.caption ? { caption: plan.ideImageAttach.caption } : {}),
            must_render_reason: plan.ideImageAttach.mustRenderReason,
            ...(plan.ideImageAttach.error ? { error: plan.ideImageAttach.error } : {}),
            action: "agent_must_render_into_ide_chat",
            instructions: ideImageAttachBlock(plan.ideImageAttach).filter((l) => l.length > 0),
          },
        }
      : {}),
  };

  const openclawMessage = {
    command: [
      "openclaw",
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      options.target,
      "--message",
      text,
      ...(media.length > 0 ? ["--media", media[0]!.url] : []),
      "--presentation",
      JSON.stringify(presentation),
    ],
    // Hint: agents that cannot run openclaw must stop and tell the user
    // they lack the native Telegram buttons tool — never downgrade.
    if_unavailable:
      "Current agent cannot run `openclaw message send`. Stop and tell the user the native Telegram inline-button tool is missing; do not downgrade to a markdown table or plain link.",
  };

  out(JSON.stringify({ presentation, openclaw_message: openclawMessage }, null, 2) + "\n");
}

export function renderTelegramInteraction(request: RenderInteractionRequest, options: TelegramRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const media = (request.media ?? []).map((item) => ({
    url: item.url,
    mimeType: item.mimeType ?? "image/png",
  }));
  const buttons =
    request.kind === "selector"
      ? request.options.map((option) => selectorButton(request.id, option))
      : [];
  const text = `${request.title} — ${request.prompt}`;
  const presentation = {
    format: request.kind === "selector" ? "text_inline_buttons" : "text",
    media,
    text,
    buttons,
    input_request:
      request.kind === "input"
        ? {
            type: "itpay_input_request",
            id: request.id,
            submit_label: request.submitLabel ?? "Submit",
            fields: request.fields,
          }
        : undefined,
    selector_request:
      request.kind === "selector"
        ? {
            type: "itpay_selector_request",
            id: request.id,
            selection_mode: request.selectionMode ?? "single",
            submit_label: request.submitLabel ?? "Confirm",
            options: request.options,
          }
        : undefined,
    blocks: [
      { type: "text", text },
      ...(media.map((item) => ({ type: "image" as const, url: item.url }))),
      ...(request.kind === "input"
        ? [{ type: "input_request", request_id: request.id, fields: request.fields }]
        : [{ type: "buttons", buttons }]),
    ],
  };

  const openclawMessage = {
    command: [
      "openclaw",
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      options.target,
      "--message",
      text,
      ...(media.length > 0 ? ["--media", media[0]!.url] : []),
      "--presentation",
      JSON.stringify(presentation),
    ],
    if_unavailable:
      "Current agent cannot run `openclaw message send`. Stop and tell the user the native Telegram input/button tool is missing; do not downgrade silently.",
  };

  out(JSON.stringify({ presentation, openclaw_message: openclawMessage }, null, 2) + "\n");
}

function collectTelegramMedia(plan: RenderPlan): Array<{ url: string; mimeType: string }> {
  const media = (plan.platform.media ?? []).map((item) => ({
    url: item.url,
    mimeType: item.mimeType ?? "image/png",
  }));
  if (plan.kind === "payment_qr" || media.length === 0) {
    media.unshift({
      url: plan.preferredQRSources.find((src) => src.length > 0) ?? plan.url,
      mimeType: "image/png",
    });
  }
  return media;
}

function selectorButton(requestID: string, option: RenderSelectorOption): RenderButton {
  return {
    label: option.label,
    kind: "callback",
    intent: "submit_selector_option",
    ref: `${requestID}:${option.id}`,
  };
}
