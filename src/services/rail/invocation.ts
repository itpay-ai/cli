import type {ServiceCapabilityInvoked,ServiceCapability} from "../../client/types.js";
import type {CommandEnvelope} from "../shared/envelope.js";
import {plainValueLines} from "../shared/envelope.js";
import {locationConfirmationEnvelope} from "./query.js";
export function railInvocationProjection(response:ServiceCapabilityInvoked,requestedCapability:ServiceCapability,input:Record<string,unknown>,itemCount:number):{early?:{value:CommandEnvelope;plainResult:string[]};catalog?:unknown;instruction?:string;suffix?:string}{
 const baseResult:Record<string,unknown>={};
 let instruction:string|undefined;
  const preview = response.invocation?.safe_result_preview;
  const notices = Array.isArray(preview?.notices) ? preview.notices.map((notice: unknown) => {
    if (!notice || typeof notice !== "object" || !("code" in notice) || !("message" in notice) || typeof notice.message !== "string") return notice;
    if (!["RAIL_TRANSFER_SCOPE_LIMIT", "RAIL_TRANSFER_SEARCH_INCOMPLETE"].includes(String(notice.code))) return notice;
    return {...notice, message: notice.message.replace(/可按主要枢纽分段查询[。；]?/g, "")};
  }) : preview?.notices;
  if ( !response.effective_quota?.exhausted && preview?.search_status === "LOCATION_CONFIRMATION_REQUIRED" && preview.location_confirmation) {
    return { early: { value: locationConfirmationEnvelope(response.execution.service_execution_id,
      requestedCapability.capability_id, input, preview.location_confirmation as Record<string, unknown>),
      plainResult: plainValueLines(preview.location_confirmation) } };
  }
  if ( typeof preview?.catalog_total === "number") {
    baseResult.catalog = {
      total: preview.catalog_total,
      recommendation: preview.recommendation,
      decision_source: preview.decision_source,
      coverage: preview.coverage,
      notices,
      search_status: preview.search_status,
      searched_scope: preview.searched_scope,
      effective_policy_hash: preview.effective_policy_hash,
      api_cost: preview.api_cost,
      stage_timestamps: preview.stage_timestamps,
      page: preview.catalog_page,
      journey_summary: preview.journey_summary,
      journeys: preview.journeys,
      train_services: preview.train_services,
      resolved_locations: preview.resolved_locations,
    };
  }
  if ( itemCount === 0 && Array.isArray(notices)) {
    const railNotice = notices.find((notice: unknown) => {
      if (!notice || typeof notice !== "object") return false;
      const value = notice as Record<string, unknown>;
      return ["RAIL_TRANSFER_SCOPE_LIMIT", "RAIL_TRANSFER_SEARCH_INCOMPLETE"].includes(String(value.code)) && typeof value.message === "string";
    }) as { message: string } | undefined;
    if (railNotice) instruction = `向用户展示官方提示：${railNotice.message} 说明本次已查范围和未完成原因，按服务端提供的当前动作恢复；不能据此断言没有车，不默认扩大范围或让用户另选分段站点。`;
  }
  if (itemCount > 0 && baseResult.catalog) {
    instruction = "先向用户说明排在首位的推荐方案和其他方案的时间、费用与便利性取舍。items 包含本次返回的合格候选，用户不满意时继续从该列表比较，不必重复查票。搜索是否完成、目录是否截断、覆盖范围和模型降级以 catalog 为准；不能把部分结果说成完整搜索。费用尚需购票前核验。姓名、身份证和手机号仅在 ItPay 网页填写。";
  }
  if ( itemCount > 0 && preview?.journey_summary) {
    instruction = "先按 journey_summary 报告本次已查询范围内的可用车次、换乘走法和实际乘车组合数量，不能用 catalog.total 或 items 数量冒充车次或组合数。按 journeys 展示组合，推荐置顶，保留全部组合和 train_services 车次列表供用户查看。每组先说明乘坐哪些车、在哪里真正换车以及等待多久；rides.onboard_stops 是同车接续停站，无需下车，可能需车内换座，不计入换乘次数。席别、余票、价格及接驳是组合下的选择，通过 candidate_ids 查对应 items；确认具体选择后才使用该 item 的编号，不猜席别或自动付款。30 分钟只是在已确认便捷换乘站点的筛选下限，不是接续保证。不得把多段票称为已可购买的套票；以 purchase_supported 为准。覆盖不完整、截断和模型仅看短名单时必须说明。姓名、身份证和手机号只在 ItPay 网页填写。";
  }

 return {...(baseResult.catalog?{catalog:baseResult.catalog}:{}),...(instruction?{instruction}:{}),...(preview?.resolved_locations?{suffix:" 按 resolved_locations 说明实际解析地点；区域级位置仅是范围代表点，接驳时间不是从用户精确位置计算的。"}:{})};
}
