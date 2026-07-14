import { type OutputSink } from "../render/sink.js";
import { CartSession } from "../state/cart_session.js";
import { type CommandEnvelope, writeCommandEnvelope } from "./guidance.js";

export interface NextOptions {
  jsonOutput?: boolean;
  output?: OutputSink;
}

export function runNext(session: CartSession, options: NextOptions = {}): void {
  const envelope = nextEnvelope(session);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}

function nextEnvelope(session: CartSession): CommandEnvelope {
  if (session.stateLoadFailed) {
    return {
      status: "local_state_invalid",
      result: {},
      instruction: "本地恢复句柄无法读取；不要猜测资源 ID，改从当前设备可见的服务执行恢复。",
      next: { command: "itpay services list --json", reason: "从服务端恢复当前设备可见的执行" },
      recovery: [],
    };
  }

  const state = session.show();
  if (state.lastServiceExecutionID) {
    return resumeEnvelope(
      "service_execution",
      state.lastServiceExecutionID,
      `itpay services next ${state.lastServiceExecutionID} --json`,
      "读取服务端最新状态",
    );
  }
  if (state.lastCheckoutID && state.lastDisplayToken) {
    return resumeEnvelope(
      "checkout",
      state.lastCheckoutID,
      `itpay checkout --id ${state.lastCheckoutID} --token ${state.lastDisplayToken} --json`,
      "恢复同一 Checkout",
    );
  }
  if (state.lastCartID) {
    return resumeEnvelope("cart", state.lastCartID, "itpay cart next --json", "读取同一 Cart 的服务端状态");
  }
  return {
    status: "nothing_to_resume",
    result: {},
    instruction: "本地没有可恢复句柄；先读取已发布目录，不要猜测 service_id。",
    next: { command: "itpay catalog list --json", reason: "选择已发布服务" },
    recovery: [],
  };
}

function resumeEnvelope(resourceType: string, resourceID: string, command: string, reason: string): CommandEnvelope {
  return {
    status: "resume_available",
    result: { resource_type: resourceType, resource_id: resourceID },
    instruction: "继续已有资源，不要创建重复订单或 Checkout。",
    next: { command, reason },
    recovery: [],
  };
}
