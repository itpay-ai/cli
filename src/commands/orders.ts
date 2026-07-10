// List V3 orders visible to the account-scoped session. Requires
// ITPAY_BEARER_TOKEN to be set to an account-scoped buyer session token.
// Order-scoped sessions are rejected by the backend with 403 and the
// CLI surfaces the typed `HttpError` so `main.ts` can render it.

import type { BackendClient } from "../client/backend.js";
import type { CLIConfig } from "../state/config.js";
import { renderOrder } from "../render/output.js";
import { hintFor } from "../render/status.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface ListOrdersOptions {
  limit: number;
  status?: string;
  output?: OutputSink;
}

export async function runListOrders(
  backend: BackendClient,
  config: CLIConfig,
  options: ListOrdersOptions,
): Promise<void> {
  const out = resolveOutput(options.output);
  if (!config.bearerToken) {
    throw new Error("ITPAY_BEARER_TOKEN is required to list account orders");
  }
  const response = await backend.listAccountOrders(options.limit, options.status, config.bearerToken);
  if (response.orders.length === 0) {
    out("no orders found\n");
    return;
  }
  for (const order of response.orders) {
    out(renderOrder(order) + "\n");
    out(`hint: ${hintFor("order", order.status)}\n\n`);
  }
}
