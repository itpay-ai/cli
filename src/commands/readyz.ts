// Liveness probe. Useful for smoke testing CLI wiring before running `buy`.

import type { BackendClient } from "../client/backend.js";
import { renderReady } from "../render/output.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface RunOptions {
  output?: OutputSink;
}

export async function runReadyz(backend: BackendClient, options: RunOptions = {}): Promise<void> {
  const out = resolveOutput(options.output);
  const response = await backend.readyz();
  out(renderReady(response) + "\n");
}
