// Create a V3 refund request. The backend decides policy state and
// returns the canonical refund status. The CLI never assumes a refund
// succeeded locally — it always re-reads canonical state.

import type { BackendClient } from "../client/backend.js";
import { operationID, type CLIConfig } from "../state/config.js";
import { renderRefund } from "../render/output.js";
import { hintFor } from "../render/status.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface RefundOptions {
  orderID: string;
  paymentIntentID: string;
  amountMinor: number;
  currency: string;
  reason?: string;
  createdBy?: string;
  output?: OutputSink;
}

export async function runRefund(backend: BackendClient, config: CLIConfig, options: RefundOptions): Promise<void> {
  const out = resolveOutput(options.output);
  const request = {
    payment_intent_id: options.paymentIntentID,
    amount_minor: options.amountMinor,
    currency: options.currency,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.createdBy ? { created_by: options.createdBy } : {}),
  };
  const refund = await backend.createRefund(
    options.orderID,
    request,
    await operationID(config, `refund.create:${options.orderID}:${options.paymentIntentID}:${options.amountMinor}:${options.currency}`),
  );
  out(renderRefund(refund) + "\n");
  out(`hint: ${hintFor("refund", refund.status)}\n`);
}
