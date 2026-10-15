import { operationInputTemplate } from "../shared/input.js";
import { railAvailableActions } from "./actions.js";
import { type ServiceExecutionReadModel, type RailJourneyCard } from "../../client/types.js";
import { type CommandAction, type CommandEnvelope, fileInputTemplate } from "../shared/envelope.js";
import { publicPurchaseTemplate, formatMoney } from "../shared/platform.js";

export function purchaseCredentialFacts(value: unknown): Record<string, unknown> {
  const expiresAt = typeof value === "string" && Number.isFinite(Date.parse(value)) && !value.startsWith("0001-") ? value : undefined;
  return {status: expiresAt ? (Date.parse(expiresAt) > Date.now() ? "not_expired" : "expired") : "unknown",
    ...(expiresAt ? {expires_at:expiresAt} : {}),
    meaning:"保存的行程是历史查询事实；重新读详情不会刷新库存或延长购买凭据。not_expired只表示期限未过，购买仍须服务端校验。"};
}

// Public summaries and saved details use the same evidenced units and scopes.
export function railJourneyFacts(card: RailJourneyCard): Record<string, unknown> {
  const offer = card.representative_offer;
  const metrics = card.representative_metrics;
  const minor = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const time = (value: unknown) => typeof value === "string" ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value.replace(" ", "T") : `${value.replace(" ", "T")}+08:00`) : NaN;
  const start = time(card.rides?.[0]?.departure), end = time(card.rides?.at(-1)?.arrival);
  return {
    rail_fare_fen: minor(offer?.fare_minor), service_fee_fen: minor(offer?.service_fee_minor),
    rail_payable_fen: minor(offer?.rail_payable_minor), currency: offer?.currency ?? null,
    price_basis: "以上票价与服务费均为本次人数的整程合计（非每人）；整程铁路应付=票价+各段服务费，不含未知地面费用，以新报价为准。",
    availability_basis: "本次库存观测可用不代表余票数量充足；只以明确的 remaining 数量判断。",
    rail_duration_minutes: Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end-start)/60000) : null,
    door_to_door_minutes: metrics?.duration_basis === "door_to_door" ? minor(metrics.door_to_door_min) : null,
    ...(metrics?.duration_basis !== "door_to_door" ? {ground_time_note: "接驳未完整核验，不能把铁路时长称为门到门时间。"} : {}),
    estimated_trip_total: metrics?.estimated_total_cost ?? null,
    estimate_basis: "仅是已核验费用范围的估算，不是含全部地面费用的实付额。",
  };
}

export function publicBookingSupport(card: RailJourneyCard): string | undefined {
  if (card.booking_support !== "separate_legs_only") return card.booking_support;
  return card.qualification_status === "eligible" && card.ticket_plans?.some(plan => plan.qualification_status === "eligible" && plan.booking_input) ? "journey" : "read_only";
}

export function compactRailJourney(card: RailJourneyCard, serviceExecutionID: string, snapshotID: string): Record<string, unknown> {
  if (!card.journey_id) throw new Error("saved journey has no stable ID");
  const rides = (card.rides ?? []).map((ride) => ({
    train_code: ride.train_code ?? (Array.isArray(ride.train_codes) ? ride.train_codes.join("/") : null),
    from_station: ride.from_station ?? null, from_station_code: ride.from_station_code ?? null,
    departure: ride.departure ?? null, to_station: ride.to_station ?? null,
    to_station_code: ride.to_station_code ?? null, arrival: ride.arrival ?? null,
    ...(typeof ride.wait_minutes === "number" ? { wait_minutes: ride.wait_minutes } : {}),
    ...(typeof ride.minimum_connection_minutes === "number" ? { required_buffer_minutes: ride.minimum_connection_minutes } : {}),
    ...(ride.same_run === true ? { same_run: true } : {}),
  }));
  const offer = card.representative_offer;
  const metrics = card.representative_metrics;
  const ticketSeats = (offer?.ticket_offers ?? []).map((raw) => ({
    leg_index: raw.leg_index, seat_type: raw.seat_type, seat_name: raw.seat_name,
    availability: raw.availability_text, remaining: raw.inventory_exact === true ? raw.remaining : null,
  }));
  return {
    journey_ref: card.journey_id,
    ...(card.profile_refs?.balanced ? { profile_ref: card.profile_refs.balanced } : {}),
    default_layer: card.default_layer ?? "main",
    ...(card.backup_reason ? { backup_reason: card.backup_reason } : {}),
    ...(card.backup_baseline_min != null ? { backup_baseline_min: card.backup_baseline_min } : {}),
    ...(card.backup_delta_min != null ? { backup_delta_min: card.backup_delta_min } : {}),
    route: card.route_text ?? (card.route_names ?? card.route ?? []).join("→"),
    rides,
    ...(card.booking_support === "single_leg" && card.qualification_status === "eligible" && card.booking_offer ? {
      purchase_credentials: purchaseCredentialFacts(card.booking_offer.expires_at),
      booking_template: {...fileInputTemplate(`itpay services run ${card.booking_offer.service_id} --input-json <file> --json`, {selection:{token:card.booking_offer.selection_token,seat_type:"<返回席别代码>"},passengers:card.passengers ?? offer?.ticket_offers?.[0]?.passengers ?? "<真实人数>"}),
        seat_choices: ticketSeats.map(seat => ({seat_type: seat.seat_type, seat_name: seat.seat_name})),
        input_example: {selection: {token: card.booking_offer.selection_token, seat_type: "<返回席别代码>"}, passengers: card.passengers ?? offer?.ticket_offers?.[0]?.passengers ?? "<真实人数>"},
        required_input: ["file", "真实席别选择及人数"],
        ...(publicPurchaseTemplate(card.purchase_operation) ?? {})},
    } : {}),
    ...(ticketSeats.length ? { seats: ticketSeats } : {}),
    booking_support: publicBookingSupport(card),
    ...(publicBookingSupport(card) === "read_only" ? {purchase_recovery: {command: `itpay services next ${serviceExecutionID} --json`, reason: "历史快照无整程凭据；读取同一执行合法准备路径，不拆单"}} : {}),
    ticket_plan_refs: (card.ticket_plans ?? []).map(plan => plan.ticket_plan_ref),
    transfer_wait_minutes: card.transfer_wait_minutes ?? [],
    ground_summary: card.ground_summary ?? null,
    passengers: card.passengers ?? offer?.ticket_offers?.[0]?.passengers ?? null,
    availability: card.availability ?? "unknown",
    qualification_status: card.qualification_status ?? "unknown",
    ...(card.qualification_reasons?.length ? { qualification_reasons: card.qualification_reasons } : {}),
    ...railJourneyFacts(card),
    cost_basis: metrics?.cost_basis ?? "unknown",
    duration_basis: metrics?.duration_basis ?? "unknown",
    timezone: "Asia/Shanghai",
    ...(card.risk_notes?.length ? { risk_notes: card.risk_notes } : {}),
    ...(card.observed_at ? { observed_at: card.observed_at } : {}),
    detail: { command: `itpay services read-result ${serviceExecutionID} --snapshot ${snapshotID} --journey ${card.journey_id} --json`,
      reason: card.qualification_status === "eligible" ? "读取此完整线路的席别、报价和购买条件" : "读取此线路的铁路事实和不可购买原因" },
  };
}

export function compactRailTicketPlan(raw: Record<string, unknown>, journeyEligible: boolean): Record<string, unknown> {
  const legs = Array.isArray(raw.legs) ? raw.legs as Record<string, unknown>[] : [];
  const seats = Array.isArray(raw.seat_offers) ? raw.seat_offers as Record<string, unknown>[][] : [];
  const tickets = Array.isArray(raw.ticket_offers) ? raw.ticket_offers as Record<string, unknown>[] : [];
  return {
    ticket_plan_ref: raw.ticket_plan_ref,
    purchase_credentials: purchaseCredentialFacts(raw.purchase_credentials && typeof raw.purchase_credentials === "object" && "expires_at" in raw.purchase_credentials ? raw.purchase_credentials.expires_at : undefined),
    passengers: raw.passenger_count ?? (Array.isArray(raw.ticket_offers) ? (raw.ticket_offers[0] as Record<string, unknown> | undefined)?.passengers : null) ?? null,
    purchase_support: raw.purchase_support === "separate_legs_only" ? "read_only" : raw.purchase_support ?? "none",
    ...(legs.length > 1 && !raw.booking_input ? {booking_unavailable: "这份快照只有历史铁路事实，没有完整整程购买凭据；不能拆腿或拼接其他快照凭据。读取同一执行当前状态，按其购买准备或过期恢复动作继续。"} : {}),
    qualification_status: raw.qualification_status ?? "unknown",
    qualification_reasons: raw.qualification_reasons ?? [],
    rail_amount_fen: raw.rail_amount_fen ?? null,
    service_fee_fen: raw.service_fee_fen ?? null,
    price_verified: raw.rail_amount_verified === true,
    ...(journeyEligible && raw.qualification_status === "eligible" && raw.booking_input && typeof raw.booking_input === "object" ? {
      booking_template: {...fileInputTemplate("itpay services run itpay-rail-booking --input-json <file> --json", raw.booking_input as Record<string, unknown>, ["passengers"]), ticket_plan_ref: raw.ticket_plan_ref, input_example: raw.booking_input,...(publicPurchaseTemplate(raw.purchase_operation) ?? {})},
    } : {}),
    legs: legs.map((leg, index) => ({
      leg_index: index,
      travel_date: leg.travel_date ?? tickets.find(ticket => ticket.leg_index === index)?.travel_date ?? null,
      ...(() => {
        const ticket = tickets.find(ticket => ticket.leg_index === index) ?? (tickets[index]?.leg_index === undefined ? tickets[index] : undefined);
        const offer = ticket?.booking_offer as {service_id?: string; selection_token?: string} | undefined;
        return legs.length === 1 && offer?.service_id && offer.selection_token && journeyEligible && raw.qualification_status === "eligible" ? {
          booking_template: {...fileInputTemplate(`itpay services run ${offer.service_id} --input-json <file> --json`, {selection:{token:offer.selection_token,seat_type:ticket?.seat_type ?? "<该方案席别代码>"},passengers:ticket?.passengers ?? raw.passenger_count ?? "<真实人数>"}),
            ticket_plan_ref: raw.ticket_plan_ref, leg_index: index,
            seat_choices: [{seat_type: ticket?.seat_type, seat_name: ticket?.seat_name}],
            input_example: {selection: {token: offer.selection_token, seat_type: ticket?.seat_type ?? "<该方案席别代码>"},
              passengers: ticket?.passengers ?? raw.passenger_count ?? "<真实人数>"},
            required_input: ["file", "真实人数", "该方案席别代码"],
          },
        } : legs.length > 1 ? {} : {booking_unavailable: "本段没有当前可用的服务端凭据；不能猜代码或例行重查。保留快照，按当前执行的恢复动作处理；过期凭据需真实新验证。"};
      })(),
      train_code: leg.train_code ?? null,
      from_station: leg.from_station ?? null, from_station_code: leg.from_station_code ?? null,
      departure: leg.departure ?? null,
      to_station: leg.to_station ?? null, to_station_code: leg.to_station_code ?? null,
      arrival: leg.arrival ?? null,
      seats: (seats[index] ?? []).map((seat) => ({ seat_type: seat.seat_type, seat_name: seat.seat_name,
        availability: seat.availability_text, remaining: seat.inventory_exact === true ? seat.remaining : null,
        unit_fare_fen: seat.fare_minor, eligible: seat.eligible === true })),
    })),
  };
}

export function railJourneySummary(card: RailJourneyCard, serviceExecutionID: string, snapshotID?: string): Record<string, unknown> {
  const rides = Array.isArray(card.rides) ? card.rides : [];
  const trains = rides.map((ride: Record<string, unknown>) => ride.train_code).filter(Boolean);
  const first = rides[0] as Record<string, unknown> | undefined;
  const last = rides.at(-1) as Record<string, unknown> | undefined;
  const offer = card.representative_offer;
  const metrics = card.representative_metrics;
  return {
    journey_id: card.journey_id,
    ...(snapshotID ? (() => { const detail = compactRailJourney(card, serviceExecutionID, snapshotID); return { rides: detail.rides, seats: detail.seats, default_layer: detail.default_layer, detail: detail.detail, ...(detail.booking_template ? {booking_template: detail.booking_template} : {}) }; })() : {}),
    route: (card.route_names?.length ? card.route_names : card.route ?? []).join("→"),
    ...(trains.length ? { trains } : {}),
    ...(first?.departure || last?.arrival ? { time: `${first?.departure ?? ""}–${last?.arrival ?? ""}` } : {}),
    ...(offer && typeof offer.rail_payable_minor === "number" ? { price: formatMoney(offer.rail_payable_minor, offer.currency) } : { price: "unknown" }),
    ...railJourneyFacts(card),
    ...(metrics ? { calculation_scope: {
      origin: metrics.origin_scope ?? "legacy_unknown", destination: metrics.destination_scope ?? "legacy_unknown",
      duration_basis: metrics.duration_basis ?? "legacy_unknown", arrival_basis: metrics.arrival_basis ?? "legacy_unknown",
      cost_basis: metrics.cost_basis ?? "legacy_unknown",
      duration_minutes: metrics.duration_basis === "door_to_door" ? metrics.door_to_door_min ?? null : railJourneyFacts(card).rail_duration_minutes,
    } } : {}),
    ...(card.decision_role ? { decision_role: card.decision_role } : {}),
    ...(card.explanation?.length ? { explanation: card.explanation } : {}),
    ...(card.reason_codes?.length ? { reason_codes: card.reason_codes } : {}),
    ...(card.tradeoff_codes?.length ? { tradeoff_codes: card.tradeoff_codes } : {}),
    ...(card.recommended_profile ? { recommended_profile: card.recommended_profile,
      profile_comparison: {scope:"within_journey",earliest_arrival_label:"本路线较早到达配置",arrival_basis:metrics?.arrival_basis ?? "unknown",rule:"profile角色不是全目录排序；不能据此宣称全局最早。"},
      recommended_price_basis: "推荐席别及已核验接驳估算以recommended_profile为准；按其ticket_plan_ref/offer_refs读取完整方案，新报价确认后下单。" } : {}),
    availability: card.availability,
    booking_support: publicBookingSupport(card),
    ...(publicBookingSupport(card) === "read_only" ? {purchase_recovery: {command: `itpay services next ${serviceExecutionID} --json`, reason: "历史快照无整程凭据；读取同一执行当前合法购买准备路径，不拆单"}} : {}),
    ...(card.observed_at ? { observed_at: card.observed_at } : {}),
    ...(card.risk_notes?.length ? { risk_notes: card.risk_notes } : {}),
    ...(card.booking_support === "single_leg"
      ? {
          select_user_chosen: `itpay services action ${serviceExecutionID} --action select_journey --actor-type human --status approved --input journey_id=${card.journey_id} --json`,
          // Delegated selection under explicit user rules is an agent action —
          // never record it as a human pick.
          select_delegated: `itpay services action ${serviceExecutionID} --action select_journey --actor-type agent --status approved --input journey_id=${card.journey_id} --input selection_mode=delegated --json`,
        }
      : {}),
  };
}

// rail.progressive.v2 read projection: committed snapshots only; polling never
// triggers supplier calls. Recommendation is absent until the decision stage
// commits — alternatives still render so users can compare early.
export function railPlanningEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const plan = model.rail_planning!;
  const se = model.execution.service_execution_id;
  const expansion = plan.search?.expansion_status ?? "running";
  const counts = plan.search?.counts;
  const journeys = [plan.recommendation, ...(plan.alternatives ?? [])].filter(Boolean) as RailJourneyCard[];
  const hasEligible = typeof counts?.journeys_eligible === "number"
    ? counts.journeys_eligible > 0 : journeys.length > 0;
  const changedScopeHint = plan.query_input && !/supplier|provider|dispatch|map|amap|permission/.test(plan.search?.reason ?? "")
    ? "若原条件锁定车站，可提议仅放宽一端到原站周边；有已核实地点证据才建议具体站，不能说肯定有票。先询问用户是否接受该端范围变化；同意后按new_query_template开新查询，未同意则保持原站。"
    : /supplier|provider|dispatch|map|amap|permission/.test(plan.search?.reason ?? "")
      ? "依赖故障按原恢复动作处理，不通过换站掩盖故障。"
      : "如需改变端点，先取得真实范围变更同意，再按正式铁路指南保留原条件发起新查询。";
  const cards = journeys.filter(card => card.journey_id !== plan.recommendation?.journey_id)
    .map((card) => railJourneySummary(card, se, plan.catalog_snapshot_id ?? plan.snapshot_id));
  // Journey counts come from the committed catalog — real combination counts,
  // never seat-row counts. Transfer buckets follow the verified transfer_count.
  const journeyMix = counts && (counts.journeys_total ?? 0) > 0
    ? `已保存${counts.journeys_total}个具体车次时刻组合，其中${counts.journeys_eligible ?? "未知"}条当前满足铁路资格（直达${counts.journeys_direct ?? 0}/1中转${counts.journeys_one_transfer ?? 0}/2中转${counts.journeys_multi_transfer ?? 0}；这些不是不同站序的数量）`
    : "";
  const pairProgress = counts && (counts.pairs_total ?? 0) > 0
    ? `已检查${counts.pairs_checked ?? 0}/${counts.pairs_total}个附近站对`
    : "";
  // §S5: failed pairs are named honestly — never implied by "checked" and
  // never rephrased as "no direct exists".
  // §S5: a rules-only recommendation after a failed model attempt is honest —
  // "rules finished, AI didn't", never silently dressed as a model pick.
  const modelDegradedHint = plan.search?.model_outcome === "fallback"
    ? "规则推荐已完成，AI模型未完成；推荐有效，但置信度说明以规则结果为准。"
    : "";
  const failedPairsHint = counts && (counts.pairs_failed ?? 0) > 0
    ? `有${counts.pairs_failed}个站对暂未查明，不能确认没有直达；已有结果仍可查看。`
    : "";
  const result: Record<string, unknown> = {
    service_execution_id: se,
    rail_planning: {
      readiness: plan.readiness,
      query_revision: plan.query_revision,
      ...(plan.query_input ? { endpoints: plan.query_input.endpoints } : {}),
      snapshot_id: plan.snapshot_id,
      expansion_status: expansion,
      ...(plan.search?.phase ? { phase: plan.search.phase } : {}),
      ...(plan.search?.transfer_status ? { transfer_status: plan.search.transfer_status } : {}),
      ...(plan.search?.transition_reason ? { transition_reason: plan.search.transition_reason } : {}),
      ...(plan.search?.authorization ? { authorization: plan.search.authorization } : {}),
      ...(plan.search?.expansion_target ? { expansion_target: plan.search.expansion_target } : {}),
      ...(plan.search?.decision_source ? { decision_source: plan.search.decision_source } : {}),
      ...(plan.search?.model_outcome ? { model_outcome: plan.search.model_outcome } : {}),
      ...(plan.search?.reason ? { reason: plan.search.reason } : {}),
      ...(plan.search?.poll_after_ms ? { poll_after_ms: plan.search.poll_after_ms } : {}),
      ...(plan.result_not_updated ? { result_not_updated: true } : {}),
      ...(counts ? { counts } : {}),
      ...(plan.coverage ? { coverage: plan.coverage } : {}),
    },
    ...(plan.notices?.length ? { notices: plan.notices } : {}),
    ...(plan.recommendation ? { recommendation: railJourneySummary(plan.recommendation, se, plan.catalog_snapshot_id ?? plan.snapshot_id) } : {}),
    ...(cards.length ? { journeys: cards } : {}),
    ...((plan.catalog_snapshot_id ?? plan.snapshot_id) ? { full_result: { command: `itpay services read-result ${se} --snapshot ${plan.catalog_snapshot_id ?? plan.snapshot_id} --json`, meaning: "读取已保存的完整目录；推荐和journeys仅是摘要" } } : {}),
    ...(!hasEligible && ["paused", "complete", "expired"].includes(expansion) && plan.query_input && plan.catalog_snapshot_id ? { new_query_template: {
      ...operationInputTemplate({serviceID:model.execution.public_binding?.public_service_id ?? model.execution.service_id,...(model.execution.public_binding ? {operationID:model.execution.public_binding.operation_id}: {})},{...plan.query_input,reuse_from:{execution_id:se,snapshot_id:plan.catalog_snapshot_id}}),
      input_example: { ...plan.query_input, reuse_from: { execution_id: se, snapshot_id: plan.catalog_snapshot_id } },
      meaning: "先取得真实范围变更同意，再复制完整input_example，仅改获准端。换具体站用station及匹配名称/站码；考虑原站周边用place及原站名，删除station_code，经正常地点解析或使用已核实POI/坐标；只有明确同意整个市才用area及完整行政名，删除POI/坐标/站码。日期、人数、时限及偏好保持；新执行不改变旧查询或订单。引用仅限同owner未过期事实，跨owner拒绝；日期变更不复用旧库存。",
    } } : {}),
    ...(plan.available_actions?.length ? { available_actions: railAvailableActions(plan,se) } : {}),
  };
  const nextPoll: CommandAction = {
    command: `itpay services next ${se} --timeout 120${plan.snapshot_id ? ` --since-snapshot ${plan.snapshot_id}` : ""} --json`,
    reason: "仍需更多结果时有界等待同一规划（不触发供应商调用）",
  };
  switch (expansion) {
    case "complete":
      if (plan.search?.reason === "ground_evidence_required") {
        return {
          status: "awaiting_input", result,
          instruction: `已查到铁路班次，但具体地址的接驳或出站证据不足，${plan.query_input?.arrive_before || plan.query_input?.arrive_by ? "无法验证用户要求的到达时限" : "尚不能核验相应地点条件或门到门时间"}；剩余站对未继续查询，不能说没有车。说明已查范围和缺失事实，请补充准确起终点地址或可验证的接驳/出站信息；补齐后按原要求规划，不默认扩大搜索。`,
          next: null, recovery: [],
        };
      }
      if (!hasEligible && !plan.result_not_updated) {
        return {
          status: "no_result", result,
          instruction: `本次已查询范围内没有当前合格线路。原因以 notices、coverage 和 search.reason 为准；缺票、接续失败、依赖故障或未覆盖范围不能改说成没有车。已有铁路事实可从 full_result 读取。${changedScopeHint}后续使用 available_actions 中与用户意图一致的动作。`,
          next: null, recovery: [],
        };
      }
      return {
        status: "ready",
        result,
        // §7.3: the lead line carries real combination counts bucketed by
        // verified transfer count — seat rows never inflate the journey count.
        instruction: `${plan.result_not_updated ? "快照没有更新，空增量不表示目录为空。" : ""}${hasEligible && journeys.length === 0 ? `已保存${counts?.journeys_eligible ?? "若干"}条合格线路，执行 full_result.command 读取。` : ""}${journeyMix ? `本次共${journeyMix}（席别不重复计数）。` : ""}${plan.search?.reason === "budget_exhausted" ? "本次查询已达到上限，以下是已查到的方案，搜索范围尚未全部核验。" : "本轮规划已完成。"}推荐和journeys是摘要；追问其他车次先读取 full_result 的已保存完整目录。比较需求说明首选与备选取舍后结束；已有明确代选委托则沿合格线路详情继续，只补缺失的真实同意，身份信息仍在官方页面填写。`,
        next: null,
        recovery: [],
      };
    case "paused": {
      if (plan.search?.reason === "legacy_plan_requires_new_search") {
        return {
          status: "awaiting_input", result,
          instruction: "这次规划使用旧算法快照，当前版本已暂停后续查询。已保存的结果仍可读取；若需继续覆盖未查范围，请按原出行条件发起一项新的 Smart 查询。不要把旧快照解释为新版完整结果。",
          next: null, recovery: [],
        };
      }
      // §7.1 case 1: usable directs committed while ranked scope remains. The
      // message must carry real counts, and expansion is a user choice — the
      // Agent must not treat "expandable" as consent already given.
      const directHint = (plan.search?.reason === "direct_options_ready" || plan.search?.phase === "direct_ready") && journeyMix
        ? `本次找到${counts?.journeys_direct ?? 0}趟可选直达（${journeyMix}），${pairProgress || "部分站对已核验"}，中转尚未展开。可以直接选一趟；时间或价格不合适时可继续搜索其它直达及中转，等待会更久。`
        : "";
      // §2.1: a delivered-pause at the authorized transfer depth names what a
      // consented expand buys next — verified-empty is "nothing at this
      // depth", never "no routes exist".
      const transferHint = (plan.search?.reason === "transfer_options_ready" || plan.search?.phase === "transfer_ready") && journeyMix
        ? `一次中转范围已核验完毕并交付（${journeyMix}）。可以直接选用；也可以继续比较两次中转方案，查询会明显更久。`
        : plan.search?.reason === "no_options_verified"
          ? `当前授权深度内的范围已核验完、未找到可用方案——这不等于没有其它路线。可授权继续更深的两次中转搜索（耗时显著增加），或停止。`
          : "";
      const expandHint = plan.search?.expansion_target === "two_transfer"
        ? "expand_search 将授权一次更深的两次中转搜索（等待更久）"
        : plan.search?.expansion_target === "more_direct_and_one_transfer"
          ? "expand_search 将补齐剩余直达并展开一次中转"
          : "expand_search 是唯一会再消耗供应商配额的命令，其余均为本地读取";
      // §7.1 case 3 on a recoverable pause: unverified scope is named with real
      // counts, and the phrasing never implies the whole nearby range ran.
      const partialPause = !directHint && counts && (counts.pairs_total ?? 0) > (counts.pairs_checked ?? 0)
        ? `已保存${counts.journeys_total ?? 0}个具体车次时刻组合，其中${counts.journeys_eligible ?? "未知"}条当前满足铁路资格；还有${(counts.pairs_total ?? 0) - (counts.pairs_checked ?? 0)}个站对/部分中转路径未核验。以下是已确认结果，不能据此断定没有其它走法。`
        : "";
      // §S5: a dispatch whose outcome is unknown pauses for reconciliation —
      // the message names the state, never rephrases it as a normal pause or
      // a no-directs result, and never offers a blind retry (expand_search is
      // withheld by the projection too).
      if (plan.search?.reason === "dispatch_outcome_unknown") {
        return {
          status: "awaiting_input",
          result,
          instruction: `${counts?.journeys_total ? `已保存${counts.journeys_total}个已核验组合仍可查看。` : ""}上一次查询发送结果未确认（可能已部分查询），系统已暂停并等待对账，不会自动重复发送，也不能据此断定没有车次。展示已有卡片，稍后可重新读取最新状态。`,
          next: null,
          recovery: [{ command: `itpay services next ${se} --json`, reason: "稍后读取对账后的最新状态" }],
        };
      }
      return {
        status: "awaiting_input",
        result,
        instruction: `${modelDegradedHint}${failedPairsHint}${directHint}${transferHint}${partialPause}${hasEligible ? "规划已发布可用结果并暂停扩展：展示现有卡片与 available_actions" : `当前已查范围尚未找到合格线路，搜索已暂停；未查范围与故障以coverage/notices为准，不是完整无解。${changedScopeHint}展示 available_actions`}，等待用户意图（${expandHint}）。ready 后 next 为空表示向用户汇报并等待，不是永远没有更多。比较需求说明首选与备选取舍后结束；已有代选委托且选项合格时沿详情继续到必要确认与官方入口。`,
        next: null,
        recovery: [],
      };
    }
    case "failed":
    case "cancelled":
    case "expired": {
      if(plan.search?.reason==="queue_expired") return {status:"queue_expired",result,
        instruction:"查询的容量等待期限已到，本次停止派发；这不是无车结论。已有铁路事实仍按返回的同快照入口读取；保留原条件，不因容量等待自动换站或扩大搜索。",next:null,recovery:[]};
      if (expansion === "failed" && !plan.snapshot_id &&
          ["address_required", "administrative_area_unresolved", "station_location_evidence_required", "coordinate_identity_unverified", "coordinate_name_mismatch", "endpoint_adcode_name_conflict", "endpoint_station_name_code_conflict", "endpoint_poi_name_conflict"].includes(plan.search?.reason ?? "")) {
        return {
          status: "awaiting_input", result,
          instruction: plan.search?.reason === "station_location_evidence_required"
            ? "尚未查票。车站身份明确，但 Smart 缺少必要地理证据；这是系统证据缺口，不要求用户换站。若双锁站仅需直达，可使用 Exact。"
            : "尚未查票。受影响端点的名称、归属或坐标尚不能一致确认；只补正该端点的真实信息，保留其余条件，不把此次失败说成无车。",
          next: null, recovery: [],
        };
      }
      // §7.1 case 3: when scope was only partially verified the honest wording
      // is "N confirmed + X pairs unverified" — never the case-2 phrasing that
      // implies the whole nearby range was checked.
      const partial = counts && (counts.pairs_total ?? 0) > (counts.pairs_checked ?? 0)
        ? `已保存${counts.journeys_total ?? 0}个具体车次时刻组合，其中${counts.journeys_eligible ?? "未知"}条当前满足铁路资格；还有${(counts.pairs_total ?? 0) - (counts.pairs_checked ?? 0)}个站对/部分中转路径未核验。以下是已确认结果，不能据此断定没有其它走法。`
        : "";
      // §S5: a processing failure with a committed catalog is "saved N
      // verified combinations, later expansion/recommend incomplete" — the
      // existing catalog stays readable and nothing implies no other routes.
      const savedCatalog = expansion === "failed" && (counts?.journeys_total ?? 0) > 0
        ? `已保存${counts?.journeys_total}个已核验组合；后续扩展/推荐未完成，原因是本次处理异常。已有方案仍可查看，不代表没有其它路线，也不需要重复提交订单或付款。`
        : "";
      return {
        status: expansion,
        result,
        instruction: `${modelDegradedHint}${failedPairsHint}${savedCatalog}${partial}${expansion === "expired" ? "规划已过期，已保存目录仍可读取并回答历史结果追问；购买须重新核验实时余票与报价。" : "本次规划已结束，展示已有结果；需要新的供应商观测时再明确发起查询。"}`,
        next: null,
        recovery: plan.snapshot_id
          ? [{ command: `itpay services read-result ${se} --snapshot ${plan.snapshot_id} --json`, reason: "读取同一任务已保存的完整目录" }]
          : [{ command: `itpay services next ${se} --json`, reason: "读取同一任务当前状态" }],
      };
    }
    default: {
      // §7.1 case 2: the automatic phase is still running. When the verified
      // stage is transfer the user must hear "direct scope found nothing
      // usable, transfer search continues" — never re-submit.
      const transferSearching = plan.search?.phase === "transfer"
        || plan.search?.transition_reason === "no_usable_direct"
        || plan.search?.transfer_status === "in_progress" || plan.search?.transfer_status === "pending";
      // §S5: an expansion the user authorized keeps earlier directs and says
      // so — it must not reuse the automatic "no usable direct" wording.
      const manualExpansion = plan.search?.authorization === "manual"
        ? `已保留之前的直达结果，正在按你的要求比较更多直达/中转及分段购票方案，需要多一点时间。`
        : "";
      const transferHint = !manualExpansion && transferSearching
        ? `已检查本次附近站范围，暂未找到符合条件且有票的直达，正在继续搜索中转组合，需要多一点时间；不需要重新提交。`
        : "";
      return {
        status: "planning",
        result,
        instruction: `${modelDegradedHint}${manualExpansion}${transferHint}${failedPairsHint}规划进行中：已提交的卡片可先向用户展示比较；稍后按 next 增量轮询同一执行（since-snapshot 命中时负载会被压缩，但阶段与计数仍返回最新值）。不要重新发起查询。`,
        next: nextPoll,
        recovery: [],
      };
    }
  }
}
