import { type ServiceExecutionReadModel } from "../../client/types.js";
import { type CommandEnvelope } from "../shared/envelope.js";

export function railLegSeatSummary(seat: { passenger_index: number; seat_type_name?: string; seat_label?: string; coach_no?: string; seat_no?: string; confirmed: boolean }) {
  return {
    passenger_index: seat.passenger_index,
    ...(seat.seat_type_name ? { seat_type_name: seat.seat_type_name } : {}),
    ...(seat.seat_label || seat.coach_no || seat.seat_no
      ? { seat: seat.seat_label ?? [seat.coach_no ? `${seat.coach_no}车` : "", seat.seat_no ?? ""].join("") }
      : {}),
    confirmed: seat.confirmed,
  };
}

export function railBookingEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const rail = model.rail_booking!;
  const execution = model.execution;
  const orderID = (model.current_delivery ?? model.delivery_bindings.at(-1))?.order_id;
  const legs = rail.legs.map((leg) => ({
    leg_index: leg.leg_index,
    state: leg.state,
    issued: leg.issued,
    ...(leg.error_code ? { error_code: leg.error_code } : {}),
    arrival_days: leg.arrival_days ?? 0,
    ...(leg.details_pending ? { details_pending: true } : {}),
    ...(leg.supplier_state ? { supplier_state: leg.supplier_state } : {}),
    ...(leg.train_code ? { train_code: leg.train_code } : {}),
    ...(leg.travel_date ? { travel_date: leg.travel_date } : {}),
    ...(leg.from || leg.to ? { route: `${leg.from ?? ""} → ${leg.to ?? ""}` } : {}),
    ...(leg.departure || leg.arrival ? { time: `${leg.departure ?? ""}–${leg.arrival ?? ""}` } : {}),
    ...(leg.seat_name ? { seat_name: leg.seat_name } : {}),
    ...(leg.seat_request ? { seat_request: leg.seat_request } : {}),
    ...(leg.seat_preferences?.length ? { seat_preferences: leg.seat_preferences } : {}),
    ...(leg.seats?.length ? { seats: leg.seats.map(railLegSeatSummary) } : {}),
  }));
  const result: Record<string, unknown> = {
    service_execution_id: execution.service_execution_id,
    ...(orderID ? { order_id: orderID } : {}),
    rail: { state: rail.state, issued_legs: rail.issued_legs, total_legs: rail.legs.length, message: rail.message, legs },
  };
  if (rail.state === "issued" && rail.issued_legs === rail.legs.length && rail.legs.length > 0) {
    const detailsPending = rail.legs.some((leg) => leg.details_pending);
    return {
      status: "issued",
      result: {...result, ...(orderID ? {aftercare: {command: `itpay order ${orderID} --json`, when: "仅用户请求核对订单或售后时"}} : {})},
      instruction: `告诉用户：车票已出票，座位以实际出票为准，平台不提供 12306 票号，可在订单页核对行程。不要在对话中索要乘车人身份信息。${detailsPending ? "部分席位信息未能同步，请前往 12306 核对行程；不要重复购买。" : ""}`,
      next: null,
      recovery: [],
    };
  }
  if (rail.state === "manual_review") {
    return {
      status: "manual_review",
      result,
      instruction: `告诉用户：付款已确认，已出票 ${rail.issued_legs}/${rail.legs.length}，其余需要人工核对；请勿重复付款或重新下单，已出票的车票会保留。未知结果先对账，退款按对应段处理，不承诺整笔退款或时效。`,
      next: orderID ? { command: `itpay order ${orderID} --json`, reason: "查看同一订单当前状态" } : null,
      recovery: [],
    };
  }
  // A rail booking run only exists after a verified payment, so payment is
  // confirmed here — but only `pending` actually means supplier issuance is in
  // flight. Any state added later falls back to a conservative re-read instead
  // of claiming issuance.
  if (rail.state === "pending") {
    return {
      status: "issuing",
      result,
      instruction: `告诉用户：付款已确认，已出票 ${rail.issued_legs}/${rail.legs.length}，后台继续处理；付款成功不代表整程出票，请勿重复购买或再次付款。稍后只读取同一任务。`,
      next: { command: `itpay services next ${execution.service_execution_id} --json`, reason: "稍后读取同一出票任务" },
      recovery: [],
    };
  }
  return {
    status: "processing",
    result,
    instruction: `告诉用户：付款已确认，订单处理状态待确认（${rail.state}）；付款成功不代表已出票，请勿重复购买或再次付款。稍后只读取同一任务。`,
    next: { command: `itpay services next ${execution.service_execution_id} --json`, reason: "稍后读取同一出票任务" },
    recovery: [],
  };
}
