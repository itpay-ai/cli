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
  reason?: string;
  output?: OutputSink;
}

export async function runRefund(backend: BackendClient, config: CLIConfig, options: RefundOptions): Promise<void> {
  const out = resolveOutput(options.output);
  if (!config.bearerToken) {
    throw new Error("ITPAY_BEARER_TOKEN is required to refund an account order");
  }
  const reason = options.reason?.trim() || "buyer_requested";
  const refund = await backend.createRefund(
    options.orderID,
    { reason },
    config.bearerToken,
    await operationID(config, `refund.create:${options.orderID}:${reason}`),
  );
  out(renderRefund(refund) + "\n");
  out(`hint: ${hintFor("refund", refund.status)}\n`);
}
