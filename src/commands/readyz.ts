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
    instruction: `ItPay ${environment === "development" ? "开发" : "正式"}环境 ${backendURL} 可用。只证明后端存活；首次使用或更新后运行 setup，不自动登录或开始业务。`,
    next: options.agentType
      ? { command: "itpay setup --json", reason: "确认同一 Backend 和宿主的设备及账号准备状态" }
      : { command: "itpay install --json", reason: "识别实际宿主类型后执行 setup" },
    recovery: [],
  }, options);
}
