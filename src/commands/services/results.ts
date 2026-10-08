import {renderExactRows,renderJourneyPage,renderJourneyDetail,exactSavedPage,savedJourneyPage,railSavedReadKind,renderExactNoResult} from "../../services/rail/readers.js";
import {serviceAdapterKey} from "../../services/registry.js";
import {renderRailResultPage} from "../../services/rail/page.js";
import { type BackendClient } from "../../client/backend.js";
import { HttpError } from "../../client/http.js";
import { decodeRailCatalogJourneys } from "../../services/rail/catalog.js";
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
  const adapter = serviceAdapterKey(execution);
  if (adapter === "rail.v1") {renderRailResultPage(response,serviceExecutionID,resultItemID,offset,limit,options);return;}
  const envelope:CommandEnvelope = {status:adapter === "unsupported" ? "presentation_contract_unavailable" : "result_page",result:{service_execution_id:serviceExecutionID,page:response.page},instruction:adapter === "unsupported" ? "当前锁定合同不受支持；保留已有结果并停止，使用兼容CLI读取同一执行。" : "这是同一已保存结果的分页；直接读取事实，不重查。",next:null,recovery:[]};
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
    result: { executions },
    instruction: executions.length === 1
      ? "只有一条可恢复记录；继续读取同一笔服务。"
      : latest
      ? "按原任务中已明确的执行ID读取对应reader；只有无法确定属于哪一笔任务时才询问用户。"
      : "当前设备没有可恢复的 Service Execution；先读取已发布目录，不要猜测 ID。",
    next: executions.length === 1
      ? { command: `itpay services next ${latest!.service_execution_id} --json`, reason: "继续唯一可恢复的服务" }
      : latest
        ? null
        : { command: "itpay catalog list --json", reason: "选择已发布服务" },
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
  if (!options.snapshot && !options.journey) {
    const model = await backend.getServiceExecution(serviceExecutionID);
    if (serviceAdapterKey(model.execution) === "rail.v1" && railSavedReadKind(model.execution) === "exact") {
      const item = (model.current_result_items?.length ? model.current_result_items : model.result_items)?.[0];
      if (!item) {
        const preview = model.provider_invocations.at(-1)?.safe_result_preview as Record<string, unknown> | undefined;
        if (renderExactNoResult(preview,serviceExecutionID,model.execution.public_binding,options)) return;
        await runServicesNext(backend, serviceExecutionID, options);
        return;
      }
      const rows: Record<string, unknown>[] = [];
      const startOffset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      if (!Number.isInteger(startOffset) || startOffset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new CommandContractError("page_invalid", "offset must be non-negative and limit 1-20", "页码无效；请按返回的 next.command 读取。", []);
      }
      let offset = startOffset;
      let total = 0;
      let resolvedStationPair: unknown;
      let nextOffset: number | null = startOffset;
      do {
        const response = await backend.getServiceExecutionResultItemPage(serviceExecutionID, item.service_capability_result_item_id, offset, limit);
        const page=exactSavedPage(response,serviceExecutionID,item.service_capability_result_item_id,offset);
        resolvedStationPair ??=page.resolvedStationPair;
        rows.push(...page.rows);total=page.total ?? Math.max(total,rows.length);nextOffset=page.nextOffset;
        offset = nextOffset ?? offset;
      } while (options.all && nextOffset !== null);
      renderExactRows(serviceExecutionID,item.service_capability_result_item_id,model.execution.public_binding,resolvedStationPair,rows,total,nextOffset,startOffset,limit,options);
      return;
    }
  }
  // rail.progressive.v2 planning read: --journey/--snapshot select committed
  // planning evidence — a free owner-validated read that never touches the
  // grant/Vault path. Without the selectors the authorized-delivery flow is
  // unchanged.
  // rail.planning catalog read: --snapshot returns compact rows for the
  // committed rail.catalog.v3; journey detail remains available separately.
  if (options.snapshot && !options.journey) {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 3;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new CommandContractError("page_invalid", "offset must be non-negative and limit 1-20", "目录页码无效；请按返回的 next.command 读取。", []);
    }
    const journeys: Record<string, unknown>[] = [];
    let nextOffset: number | null = offset;
    let total = 0;
    let truncatedReason: string | null = null;
    let qualificationCounts: { eligible: number; ineligible: number; unknown: number } | undefined;
    let planID: string | undefined;
    let queryRevision: number | undefined;
    while (nextOffset !== null) {
      let response: Awaited<ReturnType<BackendClient["getServiceExecutionResultItemPage"]>>;
      try {
        response = await backend.getServiceExecutionResultItemPage(serviceExecutionID, options.snapshot, nextOffset, limit, "summary");
      } catch (error) {
        if (error instanceof HttpError && error.code === "result_not_pageable") {
          const committed = await backend.getRailPlanningCatalog(serviceExecutionID, options.snapshot);
          decodeRailCatalogJourneys(committed.catalog);
        }
        throw error;
      }
      if (response.snapshot_id !== options.snapshot) throw new Error("saved page snapshot changed");
      planID = response.plan_id;
      queryRevision = response.query_revision;
      const page=savedJourneyPage(response,serviceExecutionID,options.snapshot,nextOffset);
      total=page.total;qualificationCounts=page.qualificationCounts ?? qualificationCounts;truncatedReason=page.truncatedReason ?? truncatedReason;
      journeys.push(...page.rows);nextOffset=page.nextOffset;
      if (!options.all) break;
    }
    renderJourneyPage(serviceExecutionID,planID,queryRevision,total,qualificationCounts,limit,truncatedReason,offset,nextOffset,journeys,options);
    return;
  }
  if (options.journey) {
    const detail = await backend.getRailJourneyDetail(serviceExecutionID, options.journey, options.snapshot);
    renderJourneyDetail(serviceExecutionID,detail,options);
    return;
  }
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
