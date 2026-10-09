import {renderExactRows,renderJourneyPage,renderJourneyDetail,exactSavedPage,savedJourneyPage,railSavedReadKind,renderExactNoResult} from "./readers.js";
import { type BackendClient } from "../../client/backend.js";
import { HttpError } from "../../client/http.js";
import { decodeRailCatalogJourneys } from "./catalog.js";
import {publicPurchaseTemplate} from "../shared/platform.js";
import { CommandContractError } from "../shared/envelope.js";

export async function readSavedResult(backend: BackendClient, model: import("../../client/types.js").ServiceExecutionReadModel, serviceExecutionID: string, options: import("../adapter.js").ResultReadOptions): Promise<"handled" | "state" | undefined> {
  if (!options.snapshot && !options.journey) {
    if (railSavedReadKind(model.execution) === "exact") {
      const item = (model.current_result_items?.length ? model.current_result_items : model.result_items)?.[0];
      if (!item) {
        const preview = model.provider_invocations.at(-1)?.safe_result_preview as Record<string, unknown> | undefined;
        if (renderExactNoResult(preview,serviceExecutionID,model.execution.public_binding,options)) return "handled";
        return "state";
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
      return "handled";
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
    return "handled";
  }
  if (options.journey) {
    let detail = await backend.getRailJourneyDetail(serviceExecutionID, options.journey, options.snapshot);
    const validate = () => {
      if (!model.execution.public_binding || detail.journey.qualification_status !== "eligible") return;
      for (const plan of detail.journey.ticket_plans ?? []) {
        if (plan.qualification_status === "eligible" && plan.booking_input) {
          if (!plan.purchase_operation) throw new CommandContractError("public_operation_contract_invalid", "missing public purchase operation", "购买合同缺失", []);
          publicPurchaseTemplate(plan.purchase_operation);
        }
      }
      if (detail.journey.booking_support === "single_leg" && detail.journey.booking_offer) {
        if (!detail.journey.purchase_operation) throw new CommandContractError("public_operation_contract_invalid", "missing public purchase operation", "购买合同缺失", []);
        publicPurchaseTemplate(detail.journey.purchase_operation);
      }
    };
    try { validate(); }
    catch (error) {
      if (!(error instanceof CommandContractError) || error.code !== "public_operation_contract_invalid") throw error;
      // One bounded owner-validated read, pinned to the returned snapshot. No provider or purchase call.
      detail = await backend.getRailJourneyDetail(serviceExecutionID, options.journey, detail.snapshot_id);
      try { validate(); }
      catch (repeated) {
        if (!(repeated instanceof CommandContractError) || repeated.code !== "public_operation_contract_invalid") throw repeated;
        throw new CommandContractError(repeated.code,repeated.message,
          "同一详情只读重取一次后购买合同仍不完整，停止。保留原执行和快照，需平台修复；不要重查、换候选、拼凭据或退旧入口。",[],undefined,
          {reason:"purchase_contract_missing",service_execution_id:serviceExecutionID,snapshot_id:detail.snapshot_id,journey_id:options.journey,readonly_recovery_attempts:1});
      }
    }
    renderJourneyDetail(serviceExecutionID,detail,options);
    return "handled";
  }
  return undefined;
}
