// Liveness probe. Useful for smoke testing CLI wiring before running `buy`.

import type { BackendClient } from "../client/backend.js";
import type { OutputSink } from "../render/sink.js";
import { writeCommandEnvelope } from "./guidance.js";

export interface RunOptions {
  output?: OutputSink;
  jsonOutput?: boolean;
  agentType?: string;
}

export async function runReadyz(backend: BackendClient, options: RunOptions = {}): Promise<void> {
  const response = await backend.readyz();
  writeCommandEnvelope({
    status: response.status,
    result: { backend: "available", ...(options.agentType ? { agent_type: options.agentType } : {}) },
    instruction: "ItPay 可用；先完整读取内置 Buyer Skill，再开始服务流程。",
    next: { command: "itpay skill show itpay-buyer --json", reason: "加载完整操作与安全规则" },
    recovery: [],
  }, options);
}
