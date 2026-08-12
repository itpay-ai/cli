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
      ? "ItPay dev 可用。先完整读取内置 Skill，再根据用户意图选择新服务、已购内容、订单或退款入口；后续必须执行返回的完整命令并保持同一 dev Backend。"
      : "ItPay 可用。先完整读取内置 Skill，再根据用户意图选择新服务、已购内容、订单或退款入口；不要默认开始购买。",
    next: { command: "itpay skill show itpay --json", reason: "加载完整操作与安全规则" },
    recovery: [],
  }, options);
}
