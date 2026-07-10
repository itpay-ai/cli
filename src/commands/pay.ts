// Optional CLI helper: only intended for the V3 `payment-intent` flow when
// the human checkout page is unavailable. The V3 architecture prefers
// that the human checkout page creates the payment intent, but the CLI
// still needs an escape hatch for sandbox/manual testing.

import type { BackendClient } from "../client/backend.js";
import { operationID, type CLIConfig } from "../state/config.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface PayOptions {
  checkoutID: string;
  method: "alipay" | "wechatpay";
  preferredProvider?: string;
  buyerID?: string;
  refreshAction?: boolean;
  output?: OutputSink;
}

export async function runPay(backend: BackendClient, config: CLIConfig, options: PayOptions): Promise<void> {
  const out = resolveOutput(options.output);
  const request = {
    payment_method_type: options.method,
    ...(options.preferredProvider ? { preferred_provider: options.preferredProvider } : {}),
    ...(options.buyerID ? { buyer_id: options.buyerID } : {}),
    ...(options.refreshAction ? { refresh_action: true } : {}),
  };
  const intent = await backend.createPaymentIntent(
    options.checkoutID,
    request,
    await operationID(config, `payment.intent:${options.checkoutID}:${options.method}`),
  );
  out(`payment_intent_id: ${intent.payment_intent_id}\n`);
  out(`status:            ${intent.status}\n`);
  out(`method:            ${intent.payment_method_type}\n`);
  out(`amount:            ${(intent.amount_minor / 100).toFixed(2)} ${intent.currency}\n`);
  if (intent.action?.qr_image_url) {
    out(`qr_image_url:      ${intent.action.qr_image_url}\n`);
  }
  if (intent.action?.mobile_wallet_url) {
    out(`mobile_wallet_url: ${intent.action.mobile_wallet_url}\n`);
  }
}
