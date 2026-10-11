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
      ? `ItPay 开发环境 ${backendURL} 可用。只证明后端存活。尚未读此次包 Skill 时完整读取；已读同版本则无需重复，继续设备状态检查；后续必须执行返回的完整命令并保持同一 Backend。`
      : "ItPay 可用。只证明后端存活。尚未读此次包 Skill 时完整读取；已读同版本则无需重复，继续设备状态检查；不自动登录或开始业务。",
    next: options.agentType
      ? { command: "itpay auth status --json", reason: "检查同一 Backend 和宿主的设备访问；login_required 不代表已登录" }
      : { command: "itpay install --json", reason: "选择实际宿主，再检查设备访问；尚未读本包 Skill 时先完整读取" },
    recovery: [],
  }, options);
}
