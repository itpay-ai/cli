import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Order, RefundRequest } from "../src/client/types.js";
import { formatMoney, renderOrder, renderRefund } from "../src/render/output.js";
import { renderPlainChat, renderPlainChatInteraction } from "../src/render/plain_chat.js";
import type { RenderPlan } from "../src/render/plan.js";
import {
  CHECKOUT_STATUS_HINTS,
  ORDER_STATUS_HINTS,
  REFUND_STATUS_HINTS,
  hintFor,
} from "../src/render/status.js";
import { renderInlineTerminalImage, supportsInlineTerminalImages } from "../src/render/terminal_image.js";

test("order and refund terminal summaries cover optional details", () => {
  assert.equal(formatMoney(1234, "CNY"), "12.34 CNY");

  const order: Order = {
    order_id: "ord_1",
    checkout_id: "chk_1",
    status: "delivered",
    amount_minor: 1234,
    currency: "CNY",
    created_at: "2026-07-20T00:00:00Z",
    paid_at: "2026-07-20T00:01:00Z",
    items: [{ title: "Report", quantity: 2, amount_minor: 1234, currency: "CNY" }],
    delivery_artifacts: [{
      delivery_artifact_id: "da_1",
      order_id: "ord_1",
      status: "claimable",
      artifact_type: "service_result",
      sensitive_content_redacted: true,
    }],
  };
  const renderedOrder = renderOrder(order);
  assert.match(renderedOrder, /order ord_1/);
  assert.match(renderedOrder, /Report × 2/);
  assert.match(renderedOrder, /da_1 claimable/);
  const unpaidOrder: Order = { ...order, items: [], delivery_artifacts: [] };
  delete unpaidOrder.paid_at;
  assert.doesNotMatch(renderOrder(unpaidOrder), /items:|paid_at|delivery_artifacts:/);

  const automatic: RefundRequest = {
    refund_request_id: "rr_1",
    order_id: "ord_1",
    status: "requested",
    amount_minor: 1234,
    currency: "CNY",
    reason: "duplicate",
    decision_mode: "automatic",
    consumption_state: "unconsumed",
    access_locked: true,
    can_cancel: true,
    created_at: "2026-07-20T00:02:00Z",
  };
  assert.match(renderRefund(automatic), /reason:  duplicate/);
  assert.match(renderRefund(automatic), /policy:  automatic/);
  const manual: RefundRequest = { ...automatic, decision_mode: "manual", access_locked: false };
  delete manual.reason;
  assert.match(renderRefund(manual), /policy:  admin review/);
});

test("status hints return every known table entry and a stable fallback", () => {
  for (const [status, hint] of Object.entries(CHECKOUT_STATUS_HINTS)) assert.equal(hintFor("checkout", status), hint);
  for (const [status, hint] of Object.entries(ORDER_STATUS_HINTS)) assert.equal(hintFor("order", status), hint);
  for (const [status, hint] of Object.entries(REFUND_STATUS_HINTS)) assert.equal(hintFor("refund", status), hint);
  assert.equal(hintFor("order", "custom"), "Status: custom");
});

test("plain-chat renders complete plans and both interaction kinds", () => {
  const output: string[] = [];
  const plan: RenderPlan = {
    kind: "checkout_qr",
    host: "plain-chat",
    summary: "Pay 12.34 CNY",
    url: "https://app.itpay.ai/checkout/chk_1",
    preferredQRSources: ["", "https://app.itpay.ai/qr/chk_1.png"],
    mobileWalletURL: "alipays://checkout/chk_1",
    checkoutID: "chk_1",
    paymentIntentID: "pi_1",
    platform: {
      text: "Pay",
      media: [{ url: "https://app.itpay.ai/brand.png" }],
      links: [{ label: "Open checkout", url: "https://app.itpay.ai/checkout/chk_1" }],
      buttons: [],
      blocks: [],
      interactions: [{
        kind: "selector",
        id: "payment_method",
        title: "Payment method",
        prompt: "Choose one",
        selectionMode: "multiple",
        media: [{ url: "https://app.itpay.ai/methods.png" }],
        options: [{ id: "alipay", label: "Alipay", value: "alipay" }],
      }],
    },
    ideImageAttach: {
      localPath: "/tmp/itpay.png",
      mirrors: [],
      mimeType: "image/png",
      source: "https://app.itpay.ai/qr/chk_1.png",
      mustRenderReason: "human checkout",
      status: "downloaded",
    },
  };
  renderPlainChat(plan, { output: (line) => output.push(line) });
  const rendered = output.join("");
  assert.match(rendered, /checkout_id: chk_1/);
  assert.match(rendered, /payment_intent_id: pi_1/);
  assert.match(rendered, /selection_mode: multiple/);
  assert.match(rendered, /canonical: `\/tmp\/itpay.png`/);

  const interaction: string[] = [];
  renderPlainChatInteraction({
    kind: "input",
    id: "contact",
    title: "Contact",
    prompt: "Enter delivery details",
    media: [{ url: "https://app.itpay.ai/contact.png" }],
    fields: [{ id: "email", label: "Email", inputType: "email", required: true }],
  }, { output: (line) => interaction.push(line) });
  assert.match(interaction.join(""), /field email: Email \(email, required\)/);
  assert.match(interaction.join(""), /reply_json:/);
});

test("inline terminal images are gated and safely encoded", () => {
  const originalIterm = process.env.ITERM_SESSION_ID;
  const originalTermProgram = process.env.TERM_PROGRAM;
  try {
    delete process.env.ITERM_SESSION_ID;
    delete process.env.TERM_PROGRAM;
    assert.equal(supportsInlineTerminalImages(), false);

    const output: string[] = [];
    renderInlineTerminalImage("/missing/itpay.png", (line) => output.push(line));
    assert.equal(output.length, 0);

    process.env.ITERM_SESSION_ID = "test-session";
    assert.equal(supportsInlineTerminalImages(), true);
    const file = join(mkdtempSync(join(tmpdir(), "itpay-inline-image-")), "qr.png");
    writeFileSync(file, Buffer.from([0x01, 0x02, 0x03]));
    renderInlineTerminalImage(file, (line) => output.push(line));
    assert.match(output.join(""), /File=name=cXIucG5n;size=3;inline=1/);
    assert.match(output.join(""), /AQID/);

    renderInlineTerminalImage("/missing/itpay.png", (line) => output.push(line));
    process.env.ITERM_SESSION_ID = "";
    process.env.TERM_PROGRAM = "iTerm.app";
    assert.equal(supportsInlineTerminalImages(), true);
  } finally {
    if (originalIterm === undefined) delete process.env.ITERM_SESSION_ID;
    else process.env.ITERM_SESSION_ID = originalIterm;
    if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = originalTermProgram;
  }
});
