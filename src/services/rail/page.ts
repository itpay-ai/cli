import type { ServiceResultItemPage, RailJourneyCard } from "../../client/types.js";
import { compactRailJourney } from "./results.js";
import { exactTrainRow } from "./query.js";
import {publicPurchaseTemplate, type ServicesCommandOptions} from "../shared/platform.js";
import {fileInputTemplate,writeCommandEnvelope, plainValueLines, type CommandEnvelope} from "../shared/envelope.js";
export function renderRailResultPage(response:ServiceResultItemPage,serviceExecutionID:string,resultItemID:string,offset:number,limit:number,options:ServicesCommandOptions & {jsonOutput?:boolean}):void {
  const page = response.page;
  const container = (page.result ?? page) as Record<string, unknown>;
  const exactCandidate = limit === 1 && Array.isArray(container.candidates) && container.candidates.length === 1
    ? container.candidates[0] as Record<string, unknown> : undefined;
  if (exactCandidate && typeof exactCandidate.train_code === "string" && Array.isArray(exactCandidate.seats)) {
    const offer = exactCandidate.booking_offer as { service_id?: string; selection_token?: string } | undefined;
    const { booking_offer: _bookingOffer, ...candidateFacts } = exactCandidate;
    const seats = (exactCandidate.seats as Record<string, unknown>[]).filter((seat) => seat.purchase_supported === true);
    writeCommandEnvelope({
      status: "exact_train_detail",
      result: {
        service_execution_id: serviceExecutionID, result_item_id: resultItemID, result_offset: offset,
        candidate: candidateFacts,
        ...(offer?.service_id && offer.selection_token ? { booking_template: {
          ...fileInputTemplate(`itpay services run ${offer.service_id} --input-json <file> --json`,{selection:{token:offer.selection_token,seat_type:"<用户授权席别对应代码>"},passengers:"<真实人数>"},["passengers","selection.seat_type"]),
          seat_choices: seats.map((choice) => ({ seat_type: choice.seat_type, seat_name: choice.seat_name })),
          input_example: { selection: { token: offer.selection_token, seat_type: "<用户授权席别对应代码>" }, passengers: "<真实人数>" },
          ...(publicPurchaseTemplate(exactCandidate.purchase_operation) ?? {}),
        } } : {}),
      },
      instruction: offer?.selection_token
        ? "这是已保存车次的当前详情；只按 purchase_supported 席别代码、库存与报价状态选择。购票模板的人数须按用户真实需求填写；查询价需在后续报价确认。若用户仅要求比较，答复后停止。"
        : "这条车次当前没有可用的购买凭据；说明席别与余票事实，不要猜测代码或构造订单。",
      next: null, recovery: [],
    }, { ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return;
  }
  // rail.progressive.v2 saved pages key journeys/journey_page; legacy result
  // items key candidates/catalog_page. Both are committed, read-only slices.
  const v2Page = (container.journey_page ?? {}) as { offset?: number; limit?: number; total?: number; count?: number; next_offset?: number | null };
  const catalogPage = (container.catalog_page ?? v2Page) as { offset?: number; limit?: number; total?: number; count?: number; next_offset?: number | null };
  const nextOffset = typeof catalogPage.next_offset === "number" ? catalogPage.next_offset : null;
  const journeys = Array.isArray(container.journeys) ? container.journeys : [];
  const candidates = Array.isArray(container.candidates) ? container.candidates : journeys;
  const envelope: CommandEnvelope = {
    status: candidates.length > 0 ? "result_page" : "result_page_end",
    result: {
      service_execution_id: response.service_execution_id,
      ...(response.service_capability_result_item_id ? { service_capability_result_item_id: response.service_capability_result_item_id } : {}),
      ...((response as { snapshot_id?: string }).snapshot_id ? { snapshot_id: (response as { snapshot_id?: string }).snapshot_id } : {}),
      offset: catalogPage.offset ?? offset,
      limit: catalogPage.limit ?? limit,
      total: catalogPage.total ?? candidates.length,
      requested_limit: limit,
      truncated_reason: (container.journey_page as Record<string, unknown> | undefined)?.truncated_reason ?? null,
      count: catalogPage.count ?? candidates.length,
      next_offset: nextOffset,
      ...(journeys.length ? { journeys: journeys.map(value => compactRailJourney(value as RailJourneyCard, serviceExecutionID, resultItemID)) }
        : candidates.some(value => typeof value === "object" && value !== null && "train_code" in value)
          ? { candidates: candidates.map((value, index) => exactTrainRow(value as Record<string, unknown>, serviceExecutionID, resultItemID, (catalogPage.offset ?? offset) + index)) } : { page }),
    },
    instruction: "读取的是已保存结果的同版本分页，不重新查询、不消耗额度。先读完所需页，再合并回答用户；不要逐页播报。",
    next: nextOffset !== null
      ? { command: (response as { snapshot_id?: string }).snapshot_id
          ? `itpay services page ${serviceExecutionID} ${resultItemID} --cursor rcur_${nextOffset} --limit ${limit} --json`
          : `itpay services page ${serviceExecutionID} ${resultItemID} --offset ${nextOffset} --limit ${limit} --json`,
        reason: "读取同版本结果的下一页" }
      : null,
    recovery: offset > 0
      ? [{ command: `itpay services page ${serviceExecutionID} ${resultItemID} --json`, reason: "回到第一页" }]
      : [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: plainValueLines(envelope.result),
  });
}
