// Liveness probe. Useful for smoke testing CLI wiring before running `buy`.

import type { BackendClient } from "../client/backend.js";
import type { OutputSink } from "../render/sink.js";
import { writeCommandEnvelope } from "./guidance.js";

export interface RunOptions {
  output?: OutputSink;
  jsonOutput?: boolean;
}

export async function runReadyz(backend: BackendClient, options: RunOptions = {}): Promise<void> {
  const response = await backend.readyz();
  writeCommandEnvelope({
    status: response.status,
    result: { backend: "available" },
    instruction: "ItPay 可用，可以读取服务目录。",
    next: { command: "itpay catalog list", reason: "发现可用服务" },
    recovery: [],
  }, options);
}
