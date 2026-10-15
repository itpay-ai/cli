import { serviceAdapter } from "../../services/registry.js";
import { type BackendClient } from "../../client/backend.js";
import { CommandContractError, type CommandEnvelope, writeCommandEnvelope, plainValueLines } from "../../services/shared/envelope.js";
import { ServicesCommandOptions, grantedResultEnvelope, servicesNextPlainResult } from "../../services/shared/platform.js";
import { runServicesNext } from "./lifecycle.js";

export async function runServicesPage(
  backend: BackendClient,
  serviceExecutionID: string,
  resultItemID: string,
  options: ServicesCommandOptions & { offset?: number; limit?: number; jsonOutput?: boolean } = {},
): Promise<void> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CommandContractError(
      "offset_invalid",
      "--offset must be a non-negative integer",
      "offset 必须是非负整数；本次未读取服务端分页。",
      [{ command: `itpay services page ${serviceExecutionID} ${resultItemID} --json`, reason: "从第一页重新读取" }],
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new CommandContractError(
      "limit_invalid",
      "--limit must be an integer from 1 to 20",
      "limit 必须是 1 到 20 的整数；本次未读取服务端分页。",
      [{ command: `itpay services page ${serviceExecutionID} ${resultItemID} --offset ${offset} --json`, reason: "用默认页大小重试" }],
    );
  }
  const response = await backend.getServiceExecutionResultItemPage(serviceExecutionID, resultItemID, offset, limit, limit === 1 ? undefined : "summary");
  const execution = response.service_id && response.service_contract_version_id
    ? {service_id:response.service_id,service_contract_version_id:response.service_contract_version_id,...(response.public_binding?{public_binding:response.public_binding}:{})}
    : (await backend.getServiceExecution(serviceExecutionID)).execution;
  const adapter = serviceAdapter(execution);
  if (adapter.renderPage(response,serviceExecutionID,resultItemID,offset,limit,options)) return;
  const envelope:CommandEnvelope = {status:!adapter.supported ? "presentation_contract_unavailable" : "result_page",result:{service_execution_id:serviceExecutionID,page:response.page},instruction:!adapter.supported ? "当前锁定合同不受支持；保留已有结果并停止，使用兼容CLI读取同一执行。" : "这是同一已保存结果的分页；直接读取事实，不重查。",next:null,recovery:[]};
  writeCommandEnvelope(envelope,{...options,plainResult:plainValueLines(envelope.result)});
}

export async function runServicesList(
  backend: BackendClient,
  options: ServicesCommandOptions & { limit?: number; jsonOutput?: boolean } = {},
): Promise<void> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CommandContractError(
      "limit_invalid",
      "--limit must be an integer from 1 to 100",
      "使用 1 到 100 的整数 limit；本次未读取服务端列表。",
      [{ command: "itpay services list --limit 10 --json", reason: "使用默认上限重试" }],
    );
  }
  const response = await backend.listServiceExecutions(limit);
  const executions = response.executions.map(({ execution }) => ({
    service_execution_id: execution.service_execution_id,
    service_id: execution.service_id,
    status: execution.status,
    phase: execution.phase,
    updated_at: execution.updated_at,
    reader: { command: `itpay services next ${execution.service_execution_id} --json`, reason: "读取这笔已有服务" },
  }));
  const latest = executions[0];
  const envelope: CommandEnvelope = {
    status: latest ? "listed" : "no_executions",
    result: { executions, limit, returned_count:executions.length, completeness:"unknown", scope:"当前设备/账户可见的可恢复记录，最多返回limit条，不代表完整历史" },
    instruction: latest
      ? "这是当前可见范围的有限列表，不能据数量判断唯一任务。只按原任务已知ID或权威关联选择对应reader；创建结果未知时不自动重发。"
      : "本次可见范围没有可恢复记录，不能证明超时创建未发生。保留原请求和已知ID；没有权威关联时停止，不自动重发或创建替代任务。",
    next:null,
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),

  });
}

export async function runServicesReadResult(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean; snapshot?: string; journey?: string; offset?: number; limit?: number; all?: boolean } = {},
): Promise<void> {
  const model = await backend.getServiceExecution(serviceExecutionID);
  const outcome = await serviceAdapter(model.execution).readResult(backend, model, serviceExecutionID, options);
  if (outcome === "handled") return;
  if (outcome === "state") { await runServicesNext(backend, serviceExecutionID, options); return; }
  const response = await backend.getGrantedServiceResult(serviceExecutionID);
  let orderID: string | undefined;
  try {
    const model = await backend.getServiceExecution(serviceExecutionID);
    orderID = (model.current_delivery ?? model.delivery_bindings.at(-1))?.order_id;
  } catch {
    // Feedback context is optional and must never block an authorized result.
  }
  const envelope = grantedResultEnvelope(response, orderID);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: servicesNextPlainResult(envelope.result),
  });
}

export async function runServicesEvents(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { afterSequence?: number; limit?: number; jsonOutput?: boolean } = {},
): Promise<void> {
  const afterSequence = options.afterSequence ?? 0;
  const limit = options.limit ?? 50;
  if (!serviceExecutionID.trim()) {
    throw new CommandContractError(
      "service_execution_id_required",
      "service execution id is required",
      "使用 services list 返回的 execution ID；不要猜测。",
      [{ command: "itpay services list --json", reason: "列出当前身份可见执行" }],
    );
  }
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new CommandContractError(
      "events_parameter_invalid",
      "after_sequence must be a non-negative integer",
      "--after-sequence 必须是非负整数；本次未读取事件。",
      [{ command: `itpay services events ${serviceExecutionID} --help`, reason: "查看诊断参数" }],
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CommandContractError(
      "events_parameter_invalid",
      "limit must be an integer between 1 and 100",
      "--limit 必须是 1 到 100 的整数；本次未读取事件。",
      [{ command: `itpay services events ${serviceExecutionID} --help`, reason: "查看诊断参数" }],
    );
  }

  const response = await backend.listServiceExecutionEvents(serviceExecutionID, afterSequence, limit);
  const events = response.events.map((event) => ({
    sequence: event.sequence,
    type: event.type,
    status: event.status,
    phase: event.phase,
    ...(event.capability_id ? { capability_id: event.capability_id } : {}),
    occurred_at: event.occurred_at,
  }));
  writeCommandEnvelope({
    status: "listed",
    result: {
      service_execution_id: serviceExecutionID,
      after_sequence: afterSequence,
      returned_count: events.length,
      events,
    },
    instruction: "这是已保存的诊断事件；事件不代表业务结果，也不授权重放业务步骤。已读完所需诊断时停止；实际任务沿先前返回的当前动作继续。",
    next: null,
    recovery: events.length === limit && events.length > 0
      ? [{
          command: `itpay services events ${serviceExecutionID} --after-sequence ${events.at(-1)!.sequence} --limit ${limit} --json`,
          reason: "继续读取下一页诊断事件",
        }]
      : [],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [
      `service_execution_id: ${serviceExecutionID}`,
      `returned_count: ${events.length}`,
      ...events.map((event) => `${event.sequence} ${event.occurred_at} ${event.type} ${event.status}/${event.phase}`),
    ],
  });
}
