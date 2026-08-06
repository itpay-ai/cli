// Liveness probe. Useful for smoke testing CLI wiring before running `buy`.

import type { BackendClient } from "../client/backend.js";
import type { OutputSink } from "../render/sink.js";
import { writeCommandEnvelope } from "./guidance.js";

export interface RunOptions {
  output?: OutputSink;
  jsonOutput?: boolean;
  agentType?: string;
  backendURL?: string;
  environment?: "production" | "development";
}

export async function runReadyz(backend: BackendClient, options: RunOptions = {}): Promise<void> {
  const response = await backend.readyz();
  const backendURL = options.backendURL ?? "https://app.itpay.ai";
  const environment = options.environment ?? "production";
  writeCommandEnvelope({
    status: response.status,
    result: { backend: "available", backend_url: backendURL, environment, ...(options.agentType ? { agent_type: options.agentType } : {}) },
    instruction: environment === "development"
      ? "ItPay dev 可用；后续必须执行返回的完整命令并保持同一个 dev Backend。只读取当前需要的 Buyer quickstart。"
      : "ItPay 可用；只读取当前需要的 Buyer quickstart，再按服务端返回的单一步骤继续。",
    next: { command: "itpay docs show quickstart --json", reason: "渐进加载当前起步规则" },
    recovery: [],
  }, options);
}
