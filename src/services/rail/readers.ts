import type { BackendClient } from "../../client/backend.js";
import type { ServiceExecution,ServiceResultItemPage,RailJourneyCard } from "../../client/types.js";
import type { ServicesCommandOptions } from "../shared/platform.js";
import { writeCommandEnvelope, CommandContractError } from "../shared/envelope.js";
import { writeSavedRailPage } from "./pagination.js";
import { exactSmartTemplate,exactTrainRow } from "./query.js";
import {compactRailJourney,compactRailTicketPlan} from "./results.js";
export type SavedReadOptions=ServicesCommandOptions & {jsonOutput?:boolean;snapshot?:string;journey?:string;offset?:number;limit?:number;all?:boolean};

export function renderExactRows(serviceExecutionID:string,itemID:string,binding:ServiceExecution["public_binding"],resolvedStationPair:unknown,rows:Record<string,unknown>[],total:number,nextOffset:number|null,startOffset:number,limit:number,options:SavedReadOptions):void{
      writeSavedRailPage({
        status: "ready",
        result: { service_execution_id: serviceExecutionID, scope: "station_pair", resolved_station_pair: resolvedStationPair,
          total, offset: startOffset, count: rows.length, read_count: rows.length,
          ...(exactSmartTemplate(resolvedStationPair, serviceExecutionID, itemID, binding)
            ? { smart_template: exactSmartTemplate(resolvedStationPair, serviceExecutionID, itemID, binding) } : {}),
          trains: rows, ...(nextOffset !== null ? { next_offset: nextOffset } : {}) },
        instruction: "这是同一已保存站对的车次行。按用户时限、席别和人数筛选；零条仅代表这一站对。纯比较答复后结束；已有购票委托则执行所选行 detail.command 读取当前席别、库存和购买凭据。",
        next: nextOffset !== null ? { command: `itpay services read-result ${serviceExecutionID} --offset ${nextOffset} --limit ${limit} --json`, reason: "继续读取同一结果的剩余车次" } : null,
        recovery: [],
      }, { ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        ...(options.output ? { output: options.output } : {}),
        all: Boolean(options.all),
      }, "trains", startOffset, next => ({ command: `itpay services read-result ${serviceExecutionID} --offset ${next} --limit ${limit} --json`, reason: "读取同一保存结果的下一页" }));
}

export function renderJourneyPage(serviceExecutionID:string,planID:string|undefined,queryRevision:number|undefined,total:number,qualificationCounts:{eligible:number;ineligible:number;unknown:number}|undefined,limit:number,truncatedReason:string|null,offset:number,nextOffset:number|null,journeys:Record<string,unknown>[],options:SavedReadOptions):void{
    writeSavedRailPage({
      status: "ready",
      result: {
        service_execution_id: serviceExecutionID,
        plan_id: planID,
        snapshot_id: options.snapshot,
        query_revision: queryRevision,
        total,
        qualification_counts: qualificationCounts,
        requested_limit: limit,
        truncated_reason: truncatedReason,
        offset,
        count: journeys.length,
        next_offset: nextOffset,
        journeys,
      },
      instruction: qualificationCounts === undefined
        ? "此历史快照没有完整资格计数；线路仅供核对铁路事实，不能据此认定可购买。沿同快照 detail.command 查看详情。"
        : qualificationCounts.eligible === 0
        ? `查到 ${total} 个时刻组合，当前 0 条满足购票资格。请读取诊断线路的 detail.command 查看具体原因；修改条件须依据用户意愿。`
        : `已查范围内合格时刻组合 ${qualificationCounts.eligible}；本次展示 ${journeys.length} 个方案（首屏优先既有主方案/代表，计数不是中转通道数）。最快/低价须按对应方案和比较范围说明；未全范围排序只能说已读方案中。更多条件优先同执行 refine_preferences 复用已存事实；页大小受字节预算限制，每页可能不满，只沿 next_offset/next 读取，不计算偏移或无收益并行，不随机翻页、不无条件读完组合。未知费用不能当免费；detail.command 读取席别和整程购买条件，购买前实时报价。`,
      next: nextOffset === null ? null : { command: `itpay services read-result ${serviceExecutionID} --snapshot ${options.snapshot} --offset ${nextOffset} --limit ${limit} --json`, reason: "仅当前问题还需未读线路时继续；已有合格完整结果可答复或按委托继续" },
      recovery: [],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
      all: Boolean(options.all),
    }, "journeys", offset, next => ({ command: `itpay services read-result ${serviceExecutionID} --snapshot ${options.snapshot} --offset ${next} --limit ${limit} --json`, reason: "仅当前问题还需未读线路时继续；已有合格完整结果可答复或按委托继续" }));
}

export function renderJourneyDetail(serviceExecutionID:string,detail:Awaited<ReturnType<BackendClient["getRailJourneyDetail"]>>,options:SavedReadOptions):void{
    const planOffset = options.offset ?? 0;
    const planLimit = options.limit ?? 3;
    if (!Number.isInteger(planOffset) || planOffset < 0 || !Number.isInteger(planLimit) || planLimit < 1 || planLimit > 20) {
      throw new CommandContractError("page_invalid", "offset must be non-negative and limit 1-20", "席别方案页码无效；请按返回的 next.command 读取。", []);
    }
    const plans = detail.journey.ticket_plans ?? [];
    const selected = options.all ? plans : plans.slice(planOffset, planOffset + planLimit);
    const nextOffset = !options.all && planOffset + selected.length < plans.length ? planOffset + selected.length : null;
    writeCommandEnvelope({
      status: "ready",
      result: {
        service_execution_id: serviceExecutionID,
        plan_id: detail.plan_id,
        snapshot_id: detail.snapshot_id,
        query_revision: detail.query_revision,
        journey: compactRailJourney(detail.journey, serviceExecutionID, detail.snapshot_id),
        ticket_plan_total: plans.length,
        ticket_plan_offset: planOffset,
        ticket_plans: selected.map(plan => compactRailTicketPlan(plan, detail.journey.qualification_status === "eligible")),
      },
      instruction: "同一线路的完整车次与席别方案。已有所需席别和有效凭据即可按真实委托继续；只需比较则答复并停止，需要其他席别才读下一页。使用所选 ticket_plan 的整程 booking_template：一个 booking、统一报价、一个官方付款入口，各段分别出票，无联合锁票或接续保证。未返回整程模板时不能拼不同方案的腿或退回逐腿付款，按同一执行恢复。身份资料只在受保护 Checkout 页面填写。",
      next: nextOffset === null ? null : { command: `itpay services read-result ${serviceExecutionID} --snapshot ${detail.snapshot_id} --journey ${options.journey} --offset ${nextOffset} --limit ${planLimit} --json`, reason: "仅需要其他席别时读取；已满足用户条件则停止翻页" },
      ...(detail.journey?.booking_support === "single_leg" ? { interaction: {
        schema_version: "itpay.interaction.v1" as const, stage: "query_results_ready",
        select_user_chosen: `itpay services action ${serviceExecutionID} --action select_journey --actor-type human --status approved --input journey_id=${detail.journey.journey_id} --json`,
        select_delegated: `itpay services action ${serviceExecutionID} --action select_journey --actor-type agent --status approved --input journey_id=${detail.journey.journey_id} --input selection_mode=delegated --json`,
      } } : {}),
      recovery: [],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
}

export function exactSavedPage(response:ServiceResultItemPage,executionID:string,itemID:string,offset:number){
 const container=(response.page.result ?? response.page) as Record<string,unknown>;
 const candidates=Array.isArray(container.candidates)?container.candidates:[];
 const page=(container.catalog_page ?? {}) as {next_offset?:number|null};
 return {rows:candidates.map((value,index)=>exactTrainRow(value as Record<string,unknown>,executionID,itemID,offset+index)),resolvedStationPair:container.resolved_station_pair,total:typeof container.catalog_total==="number"?container.catalog_total:undefined,nextOffset:typeof page.next_offset==="number" && page.next_offset>offset?page.next_offset:null};
}
export function savedJourneyPage(response:ServiceResultItemPage,executionID:string,snapshotID:string,offset:number){
 const container=(response.page.result ?? response.page) as Record<string,unknown>;
 const page=container.journey_page as {total?:number;next_offset?:number|null;truncated_reason?:string|null;qualification_counts?:{eligible:number;ineligible:number;unknown:number}}|undefined;
 const rows=Array.isArray(container.journeys)?container.journeys as RailJourneyCard[]:[];
 const next=page?.next_offset;
 if(typeof next==="number" && next<=offset)throw new Error("saved page cursor did not advance");
 return {total:typeof page?.total==="number"?page.total:rows.length,qualificationCounts:page?.qualification_counts,truncatedReason:page?.truncated_reason,rows:rows.map(card=>compactRailJourney(card,executionID,snapshotID)),nextOffset:typeof next==="number"?next:null};
}
export function railSavedReadKind(execution:ServiceExecution):"exact"|"planning"|"booking"{return execution.service_id==="itpay-rail-exact"?"exact":execution.service_id==="itpay-rail-booking"?"booking":"planning";}

export function renderExactNoResult(preview:Record<string,unknown>|undefined,executionID:string,binding:ServiceExecution["public_binding"],options:SavedReadOptions):boolean {
 const template=exactSmartTemplate(preview?.resolved_station_pair,executionID,undefined,binding);
 if(!template || preview?.catalog_total !== 0) return false;
 writeCommandEnvelope({status:"no_result",result:{service_execution_id:executionID,scope:"station_pair",resolved_station_pair:preview.resolved_station_pair,total:0,smart_template:template},instruction:"这一站对的成功观测为0条，不代表附近区域无车。若用户允许中转或原需求范围更广，保留原始区域/地点意图并沿 smart_template 引用本次事实；只要直达时不要自动转中转。",next:null,recovery:[]},{...(options.jsonOutput !== undefined?{jsonOutput:options.jsonOutput}:{}),...(options.output?{output:options.output}:{})});
 return true;
}
