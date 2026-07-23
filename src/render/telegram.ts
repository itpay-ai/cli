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
    { label: "📱 手机点这儿支付", kind: "url", url: plan.url },
    ...(plan.checkoutID
      ? [{ label: "📋 已授权给我读", kind: "callback" as const, intent: "grant_confirmed", ref: plan.checkoutID }]
      : []),
  ];
}

type TelegramButton =
  | { label: string; url: string }
  | { label: string; value: string };

function nativeButton(button: RenderButton): TelegramButton {
  if (button.kind === "url") {
    return { label: button.label, url: button.url ?? "" };
  }
  const value = button.intent === "check_checkout_status"
    ? `itp:checkout:${button.ref ?? ""}`
    : `itp:${button.intent ?? "callback"}:${button.ref ?? ""}`;
  return { label: button.label, value };
}

export function renderTelegram(plan: RenderPlan, options: TelegramRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const agentAction = buildOpenClawTelegramAction(plan, options.target);
  const presentation = agentAction.arguments.presentation;
  const media = collectTelegramMedia(plan);
  const text = agentAction.arguments.message;

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
    // Keep the same Checkout visible if native buttons are unavailable.
    if_unavailable:
      "If `openclaw message send` is unavailable, send the same QR media and Checkout URL as ordinary Telegram content, report that inline buttons are unavailable, and stop. Do not create another Checkout.",
  };

  out(JSON.stringify({ presentation, agent_action: agentAction, openclaw_message: openclawMessage }, null, 2) + "\n");
}

export function buildOpenClawTelegramAction(plan: RenderPlan, target: string): {
  tool: "message";
  arguments: {
    action: "send";
    channel: "telegram";
    target: string;
    message: string;
    media?: string;
    presentation: Record<string, unknown> & { blocks: Array<Record<string, unknown>> };
  };
} {
  const buttons = buttonsFor(plan).map(nativeButton);
  const media = collectTelegramMedia(plan);
  const message =
    plan.kind === "payment_qr"
      ? `ItPay payment QR — ${plan.summary}`
      : plan.kind === "auth_qr"
        ? `ItPay auth required — ${plan.summary}`
        : `ItPay checkout QR — ${plan.summary}`;
  const presentation = {
    blocks: [{ type: "buttons", buttons }],
  };
  const nativeTarget = target.trim().replace(/^telegram:/i, "");
  return {
    tool: "message",
    arguments: {
      action: "send",
      channel: "telegram",
      target: nativeTarget,
      message,
      ...(media[0]?.url ? { media: media[0].url } : {}),
      presentation,
    },
  };
}

export function renderTelegramInteraction(request: RenderInteractionRequest, options: TelegramRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const media = (request.media ?? []).map((item) => ({
    url: item.url,
    mimeType: item.mimeType ?? "image/png",
  }));
  const buttons =
    request.kind === "selector"
      ? request.options.map((option) => nativeButton(selectorButton(request.id, option)))
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
