import { type CommandEnvelope } from "../shared/envelope.js";

export function locationConfirmationEnvelope(executionID: string, capabilityID: string, input: Record<string, unknown>, confirmation: Record<string, unknown>): CommandEnvelope {
  input = (confirmation.input ?? input) as Record<string, unknown>;
  const endpoints = (confirmation.endpoints ?? []) as Array<{side: string; reason?: string; candidates?: unknown[]}>;
  const choices = Object.fromEntries(endpoints.map((endpoint) => [endpoint.side, "<用户选择的候选 id>"]));
  const missing = endpoints.filter((endpoint) => !endpoint.candidates?.length);
  const reason = missing[0]?.reason?.toUpperCase();
  const instruction = missing.length
    ? reason === "STATION_LOCATION_EVIDENCE_REQUIRED"
      ? "尚未查票。车站身份已知，但 Smart 缺少该站地理坐标证据；请说明此系统缺口。若用户仅要双站直达，可按原站名使用 Exact；不要要求用户换站。"
      : reason === "ADDRESS_REQUIRED" || reason === "ADMINISTRATIVE_AREA_UNRESOLVED"
      ? "尚未查票。先用已有上下文、地图或浏览补该端地点证据；含义仍不清且影响范围才问用户一个关键问题。保留另一端和原条件；只有返回完整新查询模板且已有新证据才另查，没有模板则停止，不猜旧执行输入。"
      : reason === "COORDINATE_IDENTITY_UNVERIFIED" || reason === "COORDINATE_NAME_MISMATCH"
      ? "尚未查票。提交的地点名称和坐标尚未得到一致证据；请核实该端点的真实名称或位置，保留另一端，不要把坐标声明当成人工确认。"
      : "尚未查票。地点证据不足；说明返回的原因与受影响端，先补真实证据，不改kind绕过、不把外部故障当用户歧义。当前无候选确认或完整新查询模板则停止。"
    : "尚未查票。仅向用户确认真实地点歧义，展示候选名称、地址和高德链接。具体住宅仍是目的地，附近车站只作候选；不得把选地点改成锁车站。用户选择后保留原输入，回到同一服务。";
  return {
    status: "location_confirmation_required",
    result: { service_execution_id: executionID, query: input, location_confirmation: confirmation },
    instruction,
    next: null,
    ...(confirmation.can_resume && !missing.length && endpoints.length ? {
      interaction: {
        schema_version: "itpay.interaction.v1" as const,
        stage: "location_confirmation_required",
        input_template: {
          command: `itpay services invoke ${executionID} --capability ${capabilityID} --input-json <地点确认.json> --json`,
          input: {...input, location_confirmation: { plan_id: confirmation.plan_id, token: confirmation.token, choices }},
          required_input: ["choices"],
          executable: false as const,
        },
      },
    } : {}),
    recovery: [],
  };
}

export function exactSmartTemplate(pair: unknown, executionID: string, resultItemID?: string, publicBinding?: import("../../client/types.js").ServiceExecution["public_binding"]): Record<string, unknown> | null {
  if (!pair || typeof pair !== "object") return null;
  const value = pair as Record<string, unknown>;
  if (!["origin_name", "origin_code", "destination_name", "destination_code", "travel_date"].every((key) => typeof value[key] === "string" && value[key])) return null;
  const input = { endpoints: { origin: {text: "<原始出发行政范围/地点/用户指定站>"}, destination: {text: "<原始到达行政范围/地点/用户指定站>"} },travel_date:value.travel_date,passengers:"<真实人数>",reuse_from:{execution_id:executionID,...(resultItemID?{result_item_id:resultItemID}:{})}};
  return { executable: false, verified_station_pair: value,
    instruction: "已核验站对是复用事实，不是完整用户查询。仅用户明确锁站才填 kind=station；区域/地点从原始需求填回，保留真实人数、时限和偏好，不默认为一人。",
    command: publicBinding ? `itpay services run ${publicBinding.public_service_id} --operation query_smart --input-json <原始需求.json> --json` : "itpay services run itpay-rail-smart --input-json <原始需求.json> --json",
    required_input: ["endpoints", "passengers", "用户时限与偏好"],
    input_example: publicBinding ? {input} : input };
}

export function exactTrainRow(candidate: Record<string, unknown>, executionID: string, itemID: string, offset: number): Record<string, unknown> {
  return {...compactExactTrain(candidate), result_item_id: itemID, result_offset: offset,
    detail: {command: `itpay services page ${executionID} ${itemID} --offset ${offset} --limit 1 --json`, reason: "读取此车次席别与服务端购买模板"}};
}

export function compactExactTrain(candidate: Record<string, unknown>): Record<string, unknown> {
  const seats = Array.isArray(candidate.seats) ? candidate.seats as Record<string, unknown>[] : [];
  return {
    candidate_id: candidate.candidate_id,
    train_code: candidate.train_code,
    from_station: candidate.from_station,
    from_station_code: candidate.from_station_code,
    to_station: candidate.to_station,
    to_station_code: candidate.to_station_code,
    travel_date: candidate.travel_date,
    departure: candidate.departure,
    arrival: candidate.arrival,
    purchase_supported: candidate.purchase_supported ?? Boolean(candidate.booking_offer),
    seats: seats.map((seat) => ({ seat_type: seat.seat_type, seat_name: seat.seat_name,
      availability_text: seat.availability_text, remaining: seat.remaining,
      fare_minor: seat.fare_minor, quoted_total_minor: seat.quoted_total_minor,
      purchase_supported: seat.purchase_supported, requires_price_refresh: seat.requires_price_refresh })),
  };
}
