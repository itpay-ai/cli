import {renderExactRows,renderJourneyPage,renderJourneyDetail,exactSavedPage,savedJourneyPage,railSavedReadKind,renderExactNoResult} from "./readers.js";
import { type BackendClient } from "../../client/backend.js";
import { HttpError } from "../../client/http.js";
import { decodeRailCatalogJourneys } from "./catalog.js";
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
    const detail = await backend.getRailJourneyDetail(serviceExecutionID, options.journey, options.snapshot);
    renderJourneyDetail(serviceExecutionID,detail,options);
    return "handled";
  }
  return undefined;
}
