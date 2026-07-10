// Feishu / Lark renderer for the V3 CLI. V1 had no Feishu support
// at all, so this is a fresh contract built for V3. We use Feishu's
// Interactive Card 1.0 message format: a top-level `header` + an
// `elements` array with text, image and action (button) blocks.
//
// Buttons are split between URL actions (deep link the buyer taps)
// and "interactive callback" actions (postback the bot receives).
// The host adapter (Lingo or your own bot) translates a `callback`
// intent into a `/v1/checkouts/{id}/...` follow-up call to the V3
// backend, mirroring how Telegram `itp:refresh_payment_qr:<id>` is
// handled in V1.

import type { OutputSink } from "./sink.js";
import type { RenderButton, RenderInteractionRequest, RenderPlan, RenderSelectorOption } from "./plan.js";
import { ideImageAttachBlock } from "./ide.js";

export interface FeishuRenderOptions {
  target: string; // open_id or chat_id
  host?: "feishu" | "lark";
  output?: OutputSink;
}

function actionFor(plan: RenderPlan, button: RenderButton): Record<string, unknown> {
  if (button.kind === "url" && button.url) {
    return {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: button.label },
          type: "primary",
          url: button.url,
        },
      ],
    };
  }
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: button.label },
        type: "default",
        value: {
          intent: button.intent ?? "noop",
          ref: button.ref ?? "",
          checkout_id: plan.checkoutID ?? "",
          payment_intent_id: plan.paymentIntentID ?? "",
        },
      },
    ],
  };
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
  return [
    { label: "打开 ItPay 收银台", kind: "url", url: plan.url },
    ...(plan.checkoutID
      ? [{ label: "查询 Checkout 状态", kind: "callback" as const, intent: "check_checkout_status", ref: plan.checkoutID }]
      : []),
  ];
}

export function renderFeishu(plan: RenderPlan, options: FeishuRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const host = options.host ?? "feishu";
  const buttons = buttonsFor(plan);
  const media = collectFeishuMedia(plan);
  const title =
    plan.kind === "payment_qr"
      ? "ItPay 支付二维码"
      : plan.kind === "auth_qr"
        ? "ItPay 需要买家授权"
        : "ItPay Checkout 二维码";

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: plan.summary },
      },
      ...media.map((item) => ({
        tag: "img",
        img_key: item.url,
        alt: { tag: "plain_text", content: item.alt ?? item.label ?? `${title} (image)` },
      })),
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: `checkout_id: ${plan.checkoutID ?? "-"}` },
        ],
      },
      ...buttons.map((button) => actionFor(plan, button)),
    ],
  };

  const message = {
    host,
    target: options.target,
    receive_id_type: host === "lark" ? "open_id" : "chat_id",
    msg_type: "interactive",
    card,
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

  out(JSON.stringify({ message }, null, 2) + "\n");
}

export function renderFeishuInteraction(request: RenderInteractionRequest, options: FeishuRenderOptions): void {
  const out = options.output ?? ((line: string) => process.stdout.write(line));
  const host = options.host ?? "feishu";
  const buttons =
    request.kind === "selector"
      ? request.options.map((option) => selectorButton(request.id, option))
      : [];
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: request.title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: request.prompt },
      },
      ...(request.media ?? []).map((item) => ({
        tag: "img",
        img_key: item.url,
        alt: { tag: "plain_text", content: item.alt ?? item.label ?? request.title },
      })),
      ...(request.kind === "input"
        ? request.fields.map((field) => ({
            tag: "note",
            elements: [
              {
                tag: "plain_text",
                content: `${field.label} (${field.id}, ${field.inputType}${field.required ? ", required" : ""})`,
              },
            ],
          }))
        : buttons.map((button) => actionFor({ checkoutID: "", paymentIntentID: "" } as RenderPlan, button))),
    ],
  };

  const message = {
    host,
    target: options.target,
    receive_id_type: host === "lark" ? "open_id" : "chat_id",
    msg_type: "interactive",
    card,
    ...(request.kind === "input"
      ? {
          input_request: {
            type: "itpay_input_request",
            id: request.id,
            submit_label: request.submitLabel ?? "Submit",
            fields: request.fields,
          },
        }
      : {
          selector_request: {
            type: "itpay_selector_request",
            id: request.id,
            selection_mode: request.selectionMode ?? "single",
            submit_label: request.submitLabel ?? "Confirm",
            options: request.options,
          },
        }),
  };

  out(JSON.stringify({ message }, null, 2) + "\n");
}

function collectFeishuMedia(plan: RenderPlan) {
  const media = [...(plan.platform.media ?? [])];
  const brand = plan.preferredQRSources.find((src) => src.length > 0);
  if (brand) {
    media.unshift({ url: brand, label: "QR image", alt: "ItPay QR" });
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
