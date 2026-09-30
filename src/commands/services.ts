import type { BackendClient } from "../client/backend.js";
import { HttpError } from "../client/http.js";
import { HttpTransportError } from "../client/transport.js";
import { DeviceLockBusyError, DeviceStateError } from "../state/device_authority.js";
import type {
  GrantedServiceResult,
  RecordServiceExecutionActionRequest,
  ServiceCapability,
  ServiceCapabilityInvoked,
  ServiceExecutionReadModel,
  ServiceExecutionAllowedAction,
  RailJourneyCard,
} from "../client/types.js";
import { operationID, taskJournalPath, type CLIConfig } from "../state/config.js";
import { TaskJournal } from "../state/task_journal.js";
import type { ClientHost } from "../state/client_context.js";
import { validateContext } from "../state/client_context.js";
import type { OutputSink } from "../render/sink.js";
import { dispatchRender, type DispatchOptions } from "../render/index.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildCheckoutHandoff, shouldPrepareLocalCheckoutImage } from "./checkout_handoff.js";
import { localizeCardURL, normalizeCardLocale, type CardLocale } from "../render/locale.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { decodeRailCatalogJourneys } from "./rail_catalog.js";
import { platformKeyForHost } from "../render/plan.js";
import { renderTerminalQR } from "../render/qr.js";

// Declared at execution creation: the client understands the rail.progressive.v2
// response format (rail_planning projection, snapshot paging, rsel_ handles).
// The server alone decides service version, quota and provider credentials.
const RAIL_PROGRESSIVE_FEATURES = ["rail.progressive.v2"] as const;
import { buildCheckoutQRPlan } from "./buy.js";
import {
  appendFeedbackPostmortemInstruction,
  CommandContractError,
  type CommandAction,
  type CommandEnvelope,
  isTerminalServiceExecutionStatus,
  writeCommandEnvelope,
  shellArgument,
  plainValueLines,
} from "./guidance.js";

export interface ServicesCommandOptions {
  output?: OutputSink;
  env?: NodeJS.ProcessEnv;
}

// AUTH04: record the pause point of each Service Execution so a later
// `itpay auth login` can resume the SAME task. Ids/stage/resume command only —
// no chat content, PII or credentials. Best-effort: journaling never breaks
// a command.
function journalTaskState(serviceExecutionID: string, envelope: CommandEnvelope, env: NodeJS.ProcessEnv): void {
  try {
    const journal = new TaskJournal(taskJournalPath(env));
    const serviceID = typeof envelope.result?.service_id === "string" ? envelope.result.service_id : undefined;
    journal.observe(
      serviceExecutionID,
      envelope.status,
      serviceID ? `itpay services run ${serviceID} --execution ${serviceExecutionID} --json` : undefined,
    );
  } catch {
    /* local journal is advisory; never fail the envelope */
  }
}

const serviceActionStatuses = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);

// Teaching-oriented guidance for ItPay's own rail services. The published
// workflow input schema may be permissive, so the CLI teaches the real
// contract here instead of letting agents guess field names.
interface RailFieldSpec { name: string; required?: boolean; description: string; example?: string; enum?: string }

interface RailServiceGuidance {
  when_to_use: string;
  input_fields: RailFieldSpec[];
  optional_fields?: RailFieldSpec[];
  input_example: Record<string, unknown>;
  notes?: string[];
}

const RAIL_SERVICE_GUIDANCE: Record<string, RailServiceGuidance> = {
  "itpay-rail-exact": {
    when_to_use: "已知可信站对时先用本服务核验直达；城市需求可先形成有依据的站对假设。只覆盖这一站对，不代表全城市最优。首次查询前先留2–4行路线摘要，具体方法：itpay docs show rail-booking。",
    input_fields: [
      { name: "origin", required: true, description: "已核实出发铁路站完整名称，不能以同名站代替区域", example: "<已核实出发站>" },
      { name: "destination", required: true, description: "已核实到达铁路站完整名称", example: "<已核实到达站>" },
      { name: "travel_date", required: true, description: "出行日期 YYYY-MM-DD；字段名必须是 travel_date，'date' 等别名无效", example: "<用户日期 YYYY-MM-DD>" },
    ],
    input_example: { origin: "<已核实出发站名>", destination: "<已核实到达站名>", travel_date: "<用户出行日期 YYYY-MM-DD>" },
    notes: [
      "本服务只接受这三个字段，多传字段会被供应商拒绝",
      "查询为空只说明这一已解析站对；允许中转可用Smart保持双站；改变用户指定站须先取得同意",
    ],
  },
  "itpay-rail-smart": {
    when_to_use: "需要广泛站点比较、中转或具体地址接驳时使用；有可信站对且只需先核验直达可用 Exact。首次查询前先留2–4行路线摘要，具体方法：itpay docs show rail-booking。",
    input_fields: [
      { name: "origin", required: true, description: "出发地：已知最完整的位置名或区域（城市/区县/地址均可）", example: "<原始完整地点>" },
      { name: "destination", required: true, description: "目的地：与 origin 同样的位置规则", example: "<已核实到达站>" },
      { name: "travel_date", required: true, description: "出行日期 YYYY-MM-DD；字段名必须是 travel_date", example: "<用户日期 YYYY-MM-DD>" },
    ],
    optional_fields: [
      { name: "origin_city", description: "出发地城市提示，辅助位置解析" },
      { name: "destination_city", description: "目的地城市提示" },
      { name: "origin_location", description: "已知坐标对象（高德 GCJ-02）" },
      { name: "destination_location", description: "目的地坐标对象" },
      { name: "depart_after", description: "不早于该时间出发" },
      { name: "depart_before", description: "不晚于该时间出发" },
      { name: "arrive_before", description: "不晚于该时间到达" },
      { name: "user_query", description: "旅行需求原话，最多4096 UTF-8字节；时间等明确条件仍填写对应结构化字段" },
      { name: "seat_preferences", description: "已确认的席别代码数组，不填写旅客身份" },
      { name: "priority", enum: "balanced|fastest|cheapest|safest|flexible", description: "方案偏好" },
      { name: "duration_basis", enum: "rail|door_to_door", description: "最快默认按铁路全程含换乘；明确要求且接驳证据完整时可按门到门" },
      { name: "max_transfers", description: "允许中转次数，0-2" },
      { name: "passengers", description: "成人乘客整数 1-5；不填写身份资料" },
    ],
    input_example: { origin: "<用户出发地点>", destination: "<用户目的地>", travel_date: "<用户出行日期 YYYY-MM-DD>", priority: "fastest", passengers: 1 },
    notes: [
      "位置有歧义时会进入位置确认步骤，请用户选定后继续同一执行",
      "推荐结果含每趟车的席别与余票；购票在后续受保护流程完成",
    ],
  },
};

function railServiceGuidance(serviceID: string, schema?: Record<string, unknown>): RailServiceGuidance | undefined {
  const guidance = RAIL_SERVICE_GUIDANCE[serviceID];
  if (serviceID !== "itpay-rail-smart" || !guidance || !(schema?.properties as Record<string, unknown> | undefined)?.endpoints) return guidance;
  return {
    ...guidance,
    input_fields: [
      { name: "endpoints", required: true, description: "origin/destination 各填 kind(area/place/station) 与完整 text；不确定 kind 可省略" },
      { name: "travel_date", required: true, description: "用户出行日期 YYYY-MM-DD" },
    ],
    optional_fields: (guidance.optional_fields ?? []).filter((field) => !["origin_city", "destination_city", "origin_location", "destination_location"].includes(field.name)).concat([
      { name: "reuse_from", description: "同 owner 的已保存 Exact result_item_id 或 Smart snapshot_id；端点/日期新查询可复用有效事实" },
    ]),
    input_example: { endpoints: { origin: { kind: "area", text: "<用户出发市县镇完整名称>" }, destination: { kind: "station", text: "<已核实到达站名>" } }, travel_date: "<用户出行日期 YYYY-MM-DD>" },
    notes: ["仅用当前 input_schema 支持的端点写法；不要与旧 origin/destination 混用", "唯一地点直接解析；真实歧义只询问有缺口的一端，外部故障按当前执行恢复"],
  };
}

const WORKFLOW_STEP_GUIDANCE: Record<string, { meaning: string; hint: string }> = {
  input: { meaning: "输入校验", hint: "核对本服务的输入契约和服务端错误码；本执行的输入不能凭猜测修复" },
  quota: { meaning: "额度检查", hint: "查看实际额度及授权状态；只按返回的登录或等待动作处理" },
  geo: { meaning: "位置解析", hint: "查看实际地点解析错误；有歧义时让用户选择返回的候选" },
  geo_confirm: { meaning: "确认后位置解析", hint: "核对服务端记录的候选与用户实际选择" },
  resolved: { meaning: "位置解析复核", hint: "查看未满足的实际位置条件" },
  resolved_after_confirm: { meaning: "位置确认复核", hint: "核对已确认地点与服务端复核结果" },
  search: { meaning: "供应商车次检索", hint: "查看供应商返回的错误码与当前站对；不要推断是字段或站名错误" },
  catalog: { meaning: "可行车次计算", hint: "查看已保存结果和实际过滤原因；不要无原因改日期或站点" },
  recommend: { meaning: "方案推荐", hint: "查看已保存候选和实际推荐失败原因；不要无原因放宽条件" },
  delivery: { meaning: "交付", hint: "读取当前执行状态；已有订单或付款状态不明时先核实，不重建" },
};



export async function runServicesStart(
  backend: BackendClient,
  serviceID: string,
  options: ServicesCommandOptions & { host?: string; target?: string; clientContext?: Record<string, unknown>; jsonOutput?: boolean } = {},
): Promise<void> {
  const host = options.host ?? "terminal";
  const response = await backend.startServiceExecution({
    service_id: serviceID,
    client_context: {
      host,
      features: [...RAIL_PROGRESSIVE_FEATURES],
      ...(options.target ? { target: options.target } : {}),
      ...(options.clientContext ?? {}),
    },
  });
  if (response.workflow_entry) {
    const guidance = railServiceGuidance(serviceID, response.workflow_entry.input_schema);
    writeCommandEnvelope({
      status: "input_required",
      result: { service_execution_id: response.execution.service_execution_id, service_id: serviceID, input_schema: response.workflow_entry.input_schema, ...(guidance ? { guidance } : {}) },
      instruction: guidance ? "按 result.guidance 逐项填写输入（when_to_use 说明本服务适用场景、input_fields 是必填契约、input_example 是待填示意，必须替换用户真实值），然后继续同一服务执行。不要臆造字段名。" : "根据服务声明填写输入，然后继续同一服务执行。",
      next: null,
      interaction: {
        schema_version: "itpay.interaction.v1",
        stage: "input_required",
        input_template: {
          command: `itpay services run ${serviceID} --execution ${response.execution.service_execution_id} --input-json <file> --json`,
          required_input: ["file"],
          executable: false,
        },
      },
      recovery: [] }, {...options});
    return;
  }
  const capability = response.capabilities.find((item) =>
    item.phase === response.execution.phase && !item.requires_payment,
  );
  const requiredInput = requiredInputFields(capability?.input_schema);
  const needsInput = requiredInput.length > 0;
  const command = capability && !needsInput
    ? `itpay services invoke ${response.execution.service_execution_id} --capability ${capability.capability_id} --json`
    : `itpay services next ${response.execution.service_execution_id} --json`;
  const capabilitySummary = capability ? {
    capability_id: capability.capability_id,
    required_input: requiredInput,
    input_schema: capability.input_schema,
    ...(capability.free_quota_limit !== undefined ? { free_quota_limit: capability.free_quota_limit } : {}),
  } : null;
  writeCommandEnvelope({
    status: "ready",
    result: {
      service_execution_id: response.execution.service_execution_id,
      service_id: response.execution.service_id,
      phase: response.execution.phase,
      capability: capabilitySummary,
    },
    instruction: capability
      ? "填写首选 capability 的 required_input；一次只提交当前 execution 所代表的服务意图。" + locationInputInstruction(capability.input_schema)
      : "当前没有可直接调用的 capability；读取服务端下一步，不要猜测 capability。",
    next: {
      command,
      reason: capability && !needsInput ? "执行当前允许的能力" : "读取服务端计算的下一步",
    },
    ...(capability && needsInput ? {
      interaction: {
        schema_version: "itpay.interaction.v1" as const,
        stage: "input_required",
        input_template: {
          command: `itpay services invoke ${response.execution.service_execution_id} --capability ${capability.capability_id}${requiredInput.map((field) => ` --input ${field}=<value>`).join("")} --json`,
          required_input: requiredInput,
          executable: false as const,
        },
      },
    } : {}),
    recovery: [],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [
      `service_execution_id: ${response.execution.service_execution_id}`,
      `service_id: ${response.execution.service_id}`,
      `phase: ${response.execution.phase}`,
      ...(capability ? [
        `capability: ${capability.capability_id}`,
        `required_input: ${requiredInput.length > 0 ? requiredInput.join(",") : "none"}`,
        ...(capability.free_quota_limit !== undefined ? [`free_quota_limit: ${capability.free_quota_limit}`] : []),
      ] : []),
    ],
  });
}

function locationConfirmationEnvelope(executionID: string, capabilityID: string, input: Record<string, unknown>, confirmation: Record<string, unknown>): CommandEnvelope {
  input = (confirmation.input ?? input) as Record<string, unknown>;
  const endpoints = (confirmation.endpoints ?? []) as Array<{side: string; reason?: string; candidates?: unknown[]}>;
  const choices = Object.fromEntries(endpoints.map((endpoint) => [endpoint.side, "<用户选择的候选 id>"]));
  const missing = endpoints.filter((endpoint) => !endpoint.candidates?.length);
  const reason = missing[0]?.reason;
  const instruction = missing.length
    ? reason === "STATION_LOCATION_EVIDENCE_REQUIRED"
      ? "尚未查票。车站身份已知，但 Smart 缺少该站地理坐标证据；请说明此系统缺口。若用户仅要双站直达，可按原站名使用 Exact；不要要求用户换站。"
      : reason === "ADDRESS_REQUIRED" || reason === "ADMINISTRATIVE_AREA_UNRESOLVED"
      ? "尚未查票。请只向用户询问该端点缺少的具体地址或行政归属；保留另一端和已有条件，得到信息后发起关联新查询。"
      : reason === "COORDINATE_IDENTITY_UNVERIFIED" || reason === "COORDINATE_NAME_MISMATCH"
      ? "尚未查票。提交的地点名称和坐标尚未得到一致证据；请核实该端点的真实名称或位置，保留另一端，不要把坐标声明当成人工确认。"
      : "尚未查票。地点证据不足；请说明返回的具体原因与受影响端点，不要把外部故障当作用户地点歧义。"
    : "尚未查票。仅向用户确认有真实歧义的端点，展示候选名称、地址和高德链接。用户选择后保留原输入，回到同一服务。";
  return {
    status: "location_confirmation_required",
    result: { service_execution_id: executionID, query: input, location_confirmation: confirmation },
    instruction,
    next: null,
    ...(confirmation.can_resume ? {
      interaction: {
        schema_version: "itpay.interaction.v1" as const,
        stage: "location_confirmation_required",
        input_template: {
          command: `itpay services invoke ${executionID} --capability ${capabilityID}${formatInputOptions({...input,
            location_confirmation: { plan_id: confirmation.plan_id, token: confirmation.token, choices }})} --json`,
          required_input: ["choices"],
          executable: false as const,
        },
      },
    } : {}),
    recovery: [],
  };
}

function requiredInputFields(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

function locationInputInstruction(schema: Record<string, unknown> | undefined): string {
  const properties = schema?.properties as Record<string, unknown> | undefined;
  if (properties?.endpoints) return " 两端分别填写 endpoints.origin/destination 的 kind 与完整 text；不确定 kind 可省略。区域保留范围、精确车站仅在目录验证后锁定。不要混用旧 origin/destination、手填锁站或伪造坐标。唯一地点会自动解析；只有真实多候选才让用户选返回的候选 id，地图失败应按当前执行恢复。";
  if (!properties?.origin_location || !properties?.destination_location) return "";
  if (!properties.location_confirmation) return " 地点保留用户已知最完整名称或城市范围；不要编造坐标或把城市改成同名车站。坐标及其他可选字段严格按当前 input_schema 提交。";
  return " 地点输入：先向用户说明本服务接受两个地点或城市范围。已有可信高德 GCJ-02 坐标时，可用 --input 'origin_location={\"lng\":113.0,\"lat\":23.0,\"coordinate_system\":\"gcj02\",\"source\":\"amap\"}'（数值必须替换为真实查询结果，destination_location 同理）；没有地图能力时，直接传用户已知最完整的 origin/destination，可附 origin_city/destination_city。不要编造坐标、补猜地址或把深圳等城市改成深圳站；精确站查须明确站名。用户只给城市、县或镇就保留区域意图，不追问门牌。明确地点由服务自动解析；只有返回 location_confirmation 才展示候选名称、地址和高德链接，等待用户选择，禁止自行选第一项。";
}

export async function runServicesInvoke(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const readModel = await backend.getServiceExecution(serviceExecutionID);
  const requestedCapability = readModel.capabilities.find((capability) => capability.capability_id === capabilityID);
  if (!requestedCapability) {
    throw new CommandContractError(
      "capability_not_found",
      `capability ${capabilityID} is not available on service execution ${serviceExecutionID}`,
      "使用 Service Execution 当前返回的 capability_id，不要猜测名称。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前可用 capability" }],
    );
  }
  if (requestedCapability.requires_payment) {
    throw new CommandContractError(
      "checkout_required",
      `capability ${capabilityID} requires checkout and cannot be invoked directly`,
			"付费 capability 不能直接 invoke。不要尝试 quote、cart、buy、checkout 或 pay 作为旁路；只恢复同一 Execution 的当前合法动作。",
			[{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取同一 Execution 的当前合法动作" }],
    );
  }
  const missingInput = missingRequiredInput(requestedCapability.input_schema, input);
  if (missingInput.length > 0) {
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "只补缺失字段到小JSON文件，再提交同一执行；本次尚未调用供应商。",
      [],
      { schema_version: "itpay.interaction.v1", stage: "input_required",
        input_template: { command: `itpay services invoke ${serviceExecutionID} --capability ${capabilityID} --input-json <file> --json`,
          required_input: ["file", ...missingInput], executable: false } },
    );
  }

  const idempotencyKey = await operationID(config, `service.invoke:${serviceExecutionID}:${capabilityID}:${stableInput(input)}`);
  let response: ServiceCapabilityInvoked;
  try {
    response = await backend.invokeServiceCapability(serviceExecutionID, capabilityID, {
      idempotency_key: idempotencyKey,
      redacted_summary: input,
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "verified_phone_required") throw error;
    writeCommandEnvelope({
      status: "human_action_required",
      result: { service_execution_id: serviceExecutionID, error_code: "verified_phone_required" },
      instruction: "需要在官方页面完成手机号验证后当前执行才能继续。运行 itpay auth login 打开官方登录页，完成手机号验证并绑定本设备后重试原命令；CLI 不接收手机号或验证码。",
      next: { command: "itpay auth login --json", reason: "完成官方手机号验证并绑定当前设备" },
      recovery: [{ command: `itpay services invoke ${serviceExecutionID} --capability ${capabilityID}${formatInputOptions(input)} --json`, reason: "仅在完成手机号验证与设备绑定后重试" }],
    }, { ...options, plainResult: ["手机号验证：itpay auth login"] });
    return;
  }
  const envelope = invokedEnvelope(response, requestedCapability, readModel.capabilities, input);
  writeCommandEnvelope(envelope.value, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: envelope.plainResult,
  });
}

function invokedEnvelope(
  response: ServiceCapabilityInvoked,
  requestedCapability: ServiceCapability,
  capabilities: ServiceCapability[],
  input: Record<string, unknown>,
): { value: CommandEnvelope; plainResult: string[] } {
  if (response.execution_request_id) {
    const id = response.execution.service_execution_id;
    return { value: { status: "running", result: {service_execution_id: id, execution_request_id: response.execution_request_id},
      instruction: "查询已排队或正在运行。告知用户稍候，只读取同一任务的状态；不要重新发起查询，也不要把暂未返回结果说成没有车。",
      next: {command: `itpay services next ${id} --json`, reason: "稍后读取同一查询结果"}, recovery: [] },
      plainResult: ["status: running", `service_execution_id: ${id}`] };
  }
  const items = response.result_items.map((item) => ({
    rank: item.rank,
    title: item.display_title,
    safe_payload: item.safe_payload,
  }));
  const quota = response.effective_quota
    ? { remaining: response.effective_quota.remaining, limit: response.effective_quota.limit }
    : undefined;
  const baseResult: Record<string, unknown> = {
    service_execution_id: response.execution.service_execution_id,
    capability_id: requestedCapability.capability_id,
    query: input,
    items,
    ...(quota ? { quota } : {}),
  };
  const preview = response.invocation?.safe_result_preview;
  const notices = Array.isArray(preview?.notices) ? preview.notices.map((notice: unknown) => {
    if (!notice || typeof notice !== "object" || !("code" in notice) || !("message" in notice) || typeof notice.message !== "string") return notice;
    if (!["RAIL_TRANSFER_SCOPE_LIMIT", "RAIL_TRANSFER_SEARCH_INCOMPLETE"].includes(String(notice.code))) return notice;
    return {...notice, message: notice.message.replace(/可按主要枢纽分段查询[。；]?/g, "")};
  }) : preview?.notices;
  if (!response.effective_quota?.exhausted && preview?.search_status === "LOCATION_CONFIRMATION_REQUIRED" && preview.location_confirmation) {
    return { value: locationConfirmationEnvelope(response.execution.service_execution_id,
      requestedCapability.capability_id, input, preview.location_confirmation as Record<string, unknown>),
      plainResult: plainValueLines(preview.location_confirmation) };
  }
  if (typeof preview?.catalog_total === "number") {
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
  let status = items.length > 0 ? "result_ready" : "no_result";
  let instruction = items.length > 0
		? "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时，才提交对应编号；不要向用户提及 safe_payload、Execution 或内部 ID。"
    : `没有找到与“${queryText(input)}”匹配的结果。向用户展示本次为 0 个结果并停止。不要修改、缩短或猜测其他输入；只有用户明确提供新输入后，才能启动新的查询。`;
  if (items.length === 0 && Array.isArray(notices)) {
    const railNotice = notices.find((notice: unknown) => {
      if (!notice || typeof notice !== "object") return false;
      const value = notice as Record<string, unknown>;
      return ["RAIL_TRANSFER_SCOPE_LIMIT", "RAIL_TRANSFER_SEARCH_INCOMPLETE"].includes(String(value.code)) && typeof value.message === "string";
    }) as { message: string } | undefined;
    if (railNotice) instruction = `向用户展示官方提示：${railNotice.message} 说明本次已查范围和未完成原因，按服务端提供的当前动作恢复；不能据此断言没有车，不默认扩大范围或让用户另选分段站点。`;
  }
  let next: CommandAction | null = null;
  if (items.length > 0 && baseResult.catalog) {
    instruction = "先向用户说明排在首位的推荐方案和其他方案的时间、费用与便利性取舍。items 包含本次返回的合格候选，用户不满意时继续从该列表比较，不必重复查票。搜索是否完成、目录是否截断、覆盖范围和模型降级以 catalog 为准；不能把部分结果说成完整搜索。费用尚需购票前核验。姓名、身份证和手机号仅在 ItPay 网页填写。";
  }
  if (items.length > 0 && preview?.journey_summary) {
    instruction = "先按 journey_summary 报告本次已查询范围内的可用车次、换乘走法和实际乘车组合数量，不能用 catalog.total 或 items 数量冒充车次或组合数。按 journeys 展示组合，推荐置顶，保留全部组合和 train_services 车次列表供用户查看。每组先说明乘坐哪些车、在哪里真正换车以及等待多久；rides.onboard_stops 是同车接续停站，无需下车，可能需车内换座，不计入换乘次数。席别、余票、价格及接驳是组合下的选择，通过 candidate_ids 查对应 items；确认具体选择后才使用该 item 的编号，不猜席别或自动付款。30 分钟只是在已确认便捷换乘站点的筛选下限，不是接续保证。不得把多段票称为已可购买的套票；以 purchase_supported 为准。覆盖不完整、截断和模型仅看短名单时必须说明。姓名、身份证和手机号只在 ItPay 网页填写。";
  }

  if (response.effective_quota?.exhausted) {
    status = "quota_exhausted";
    instruction = "免费额度已用完且本次没有调用 Provider。当前没有可购买的 continuation；只读取同一 Execution 的服务端恢复方向。";
    const checkoutAction = response.next_actions?.find((action) => action.kind === "create_checkout");
    const checkoutCapability = capabilities.find((capability) => capability.capability_id === checkoutAction?.capability_id);
    if (checkoutCapability) {
      baseResult.checkout = {
        capability_id: checkoutCapability.capability_id,
        ...(checkoutCapability.price_amount_minor !== undefined && checkoutCapability.price_currency ? {
          price: { amount_minor: checkoutCapability.price_amount_minor, currency: checkoutCapability.price_currency },
        } : {}),
        delivery_email_required: checkoutCapability.delivery_email_required,
      };
      const price = capabilityPrice(checkoutCapability);
      instruction = purchaseConfirmationInstruction(
        "quota_exhausted",
        price,
        checkoutCapability.delivery_email_required,
        checkoutCapability.delivery_email_purpose,
      );
      next = {
				command: checkoutCommand(response.execution.service_execution_id, checkoutCapability, input),
				reason: `仅在用户明确同意支付 ${price} 后执行；否则停止`,
      };
    } else {
      next = {
        command: `itpay services next ${response.execution.service_execution_id} --json`,
        reason: "读取服务端提供的付费恢复入口",
      };
    }
  } else if (items.length > 0 && requestedCapability.requires_human_action) {
    next = null;
  } else if (items.length === 0) {
    next = null;
  }
  const interaction = items.length > 0 && requestedCapability.requires_human_action
    ? {
        schema_version: "itpay.interaction.v1" as const,
        stage: "query_results_ready",
        input_template: {
          command: `itpay services action ${response.execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
          required_input: ["rank"],
          executable: false as const,
        },
      }
    : undefined;
  if (preview?.resolved_locations) instruction += " 按 resolved_locations 说明实际解析地点；区域级位置仅是范围代表点，接驳时间不是从用户精确位置计算的。";

  return {
    value: { status, result: baseResult, instruction, next, recovery: [], ...(interaction ? { interaction } : {}) },
    plainResult: serviceResultPlainLines(baseResult),
  };
}

function serviceResultPlainLines(result: Record<string, unknown>): string[] {
  return plainValueLines(result);
}

function queryText(input: Record<string, unknown>): string {
  const value = Object.values(input).find((item) => typeof item === "string" && item.trim() !== "");
  return typeof value === "string" ? value : JSON.stringify(input);
}

function missingRequiredInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): string[] {
  return requiredInputFields(schema).filter((field) => {
    if (!(field in input) || input[field] === null || input[field] === undefined) return true;
    return typeof input[field] === "string" && String(input[field]).trim() === "";
  });
}

function checkoutCommand(
  serviceExecutionID: string,
  capability: ServiceCapability,
  input: Record<string, unknown>,
	fillMissing = true,
): string {
  const lockedInput = { ...input };
	if (fillMissing) {
		for (const field of missingRequiredInput(capability.input_schema, lockedInput)) lockedInput[field] = "<value>";
	}
  return `itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)}${capability.delivery_email_required ? " --email <email>" : ""} --json`;
}

function capabilityPrice(capability: ServiceCapability): string {
	if (capability.pricing_method === "rail_fare_plus_fee") return "实时票款 + 每张票 2 元服务费（最终金额以锁定报价为准）";
	return capability.price_amount_minor !== undefined && capability.price_currency
		? formatMoney(capability.price_amount_minor, capability.price_currency)
		: "当前发布价格";
}

function purchaseConfirmationInstruction(
	context: "quota_exhausted" | "candidate_selected",
	price: string,
	deliveryEmailRequired: boolean,
	deliveryEmailPurpose?: ServiceCapability["delivery_email_purpose"],
	candidateTitle = "",
): string {
	const emailPurpose = deliveryEmailPurposeText(deliveryEmailPurpose);
	if (context === "quota_exhausted") {
		return deliveryEmailRequired
			? `免费额度已用完，本次没有发送到数据来源，也没有创建付款页面。只向用户说明：继续当前请求需要支付 ${price}，并提供${emailPurpose}；请确认是否购买并提供邮箱。然后停止等待。用户明确同意并提供真实邮箱前，Agent 不执行 next.command，也不创建或尝试其他购买路径。`
			: `免费额度已用完，本次没有发送到数据来源，也没有创建付款页面。只向用户说明：“继续当前请求需要支付 ${price}，是否购买？”然后停止等待。用户明确同意前，Agent 不执行 next.command，也不创建或尝试其他购买路径。`;
	}
	const selected = candidateTitle ? `已选择 ${candidateTitle}。` : "当前候选已经确认。";
	return deliveryEmailRequired
		? `${selected}后续服务尚未购买。只向用户说明：继续购买需要支付 ${price}，并提供${emailPurpose}；请确认是否购买并提供邮箱。然后停止。用户明确同意并提供真实邮箱前，Agent 不执行 next.command，也不创建新的服务或付款页面。`
		: `${selected}后续服务尚未购买。只向用户说明：“继续购买后续服务需要支付 ${price}，是否购买？”然后停止。用户明确同意前，Agent 不执行 next.command，也不创建新的服务或付款页面。`;
}

function deliveryEmailPurposeText(purpose?: ServiceCapability["delivery_email_purpose"]): string {
	switch (purpose) {
		case "receipt":
			return "用于发送订单收据的真实邮箱";
		case "claim":
			return "用于发送交付认领链接的真实邮箱";
		case "receipt_and_claim":
			return "用于发送订单收据和交付认领链接的真实邮箱";
		default:
			return "服务端声明用途的真实邮箱";
	}
}

function paidContinuation(
	model: ServiceExecutionReadModel,
	action: ServiceExecutionAllowedAction,
	input: Record<string, unknown>,
): {
	capability: ServiceCapability;
	price: string;
	checkout: Record<string, unknown>;
	next: CommandAction;
} | null {
	if (!action.capability_id) return null;
	const capability = model.capabilities.find((item) => item.capability_id === action.capability_id && item.requires_payment);
	if (!capability) return null;
	const price = capabilityPrice(capability);
	const stateBacked = model.execution.status === "quota_exhausted" || model.execution.status === "human_action_approved";
	return {
		capability,
		price,
		checkout: {
			capability_id: capability.capability_id,
			...(capability.price_amount_minor !== undefined && capability.price_currency ? {
				price: { amount_minor: capability.price_amount_minor, currency: capability.price_currency },
			} : {}),
			delivery_email_required: capability.delivery_email_required,
			...(capability.delivery_email_purpose ? { delivery_email_purpose: capability.delivery_email_purpose } : {}),
		},
		next: {
			command: checkoutCommand(model.execution.service_execution_id, capability, input, !stateBacked),
			reason: `仅在用户明确同意支付 ${price}${capability.delivery_email_required ? " 并提供真实邮箱" : ""}后执行；否则停止`,
		},
	};
}

function quoteCommand(
  serviceExecutionID: string,
  capability: ServiceCapability,
  input: Record<string, unknown>,
): string {
	const lockedInput = { ...input };
	for (const field of missingRequiredInput(capability.input_schema, lockedInput)) lockedInput[field] = "<value>";
	return `itpay services quote ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)}${capability.delivery_email_required ? " --email <email>" : ""} --json`;
}

function stableInput(input: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
}

function formatInputOptions(input: Record<string, unknown>): string {
  return Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => String(value) === "<value>"
      ? ` --input ${key}=<value>`
      : ` --input ${shellArgument(`${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)}`)
    .join("");
}


export async function runServicesAction(
  backend: BackendClient,
  serviceExecutionID: string,
  actionType: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & {
    actorType?: string;
    actorID?: string;
    status?: string;
    resultItemID?: string;
    candidateRank?: number;
    requiredBefore?: string;
    jsonOutput?: boolean;
  } = {},
): Promise<void> {
  const selection = await resolveCandidateSelection(backend, serviceExecutionID, actionType, options);
  const request: RecordServiceExecutionActionRequest = {
    action_type: actionType,
    input_snapshot: input,
  };
  if (options.actorType) request.actor_type = options.actorType;
  if (options.actorID) request.actor_id = options.actorID;
  if (options.status) request.status = normalizeServiceActionStatus(options.status, serviceExecutionID);
  const resultItemID = selection?.resultItemID ?? options.resultItemID;
  if (resultItemID) request.result_item_id = resultItemID;
  if (options.requiredBefore) request.required_before = options.requiredBefore;
	let response;
	try {
		response = await backend.recordServiceExecutionAction(serviceExecutionID, request);
	} catch (error) {
		if (error instanceof HttpError && ["booking_review_invalid", "booking_review_changed", "booking_review_locked"].includes(error.code)) {
			throw new CommandContractError(
				error.code,
				error.message,
				error.code === "booking_review_invalid"
					? "确认输入与当前草稿不符。重新读取同一booking的review模板，席别使用返回的代码，不填显示名或猜新值。若仅修正代码写法，且车次、实际席别、人数、价格及条款等已确认内容未变，可沿用用户已有明确确认后提交；草稿实质变化或缺少真实同意时，先请用户确认变化内容。"
					: error.code === "booking_review_changed"
						? "草稿版本已变化；重新读取同一booking的当前review与revision，经用户核对后再提交。"
						: "当前购买已有付款尝试；读取同一booking及订单状态，不创建新订单或重做付款。",
				[{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取同一booking的当前状态与review" }],
			);
		}
		throw error;
	}
	if ("state" in response) {
		const updated = await backend.getServiceExecution(serviceExecutionID);
		const envelope = servicesNextEnvelope(updated);
		envelope.result = {
			...envelope.result,
			planning_action: { action_id: response.action_id, state: response.state, replayed: response.replayed },
		};
		writeCommandEnvelope(envelope, {
			...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
			...(options.output ? { output: options.output } : {}),
		});
		return;
	}
	if (selection && actionType === "select_candidate" && response.status === "approved") {
		const updated = await backend.getServiceExecution(serviceExecutionID);
		const preferred = updated.allowed_actions?.[0];
		const continuation = preferred?.type === "prepare_quote"
			? paidContinuation(updated, preferred, {})
			: null;
		const next = continuation?.next ?? (preferred ? serviceAllowedActionCommand(updated, preferred) : null);
		writeCommandEnvelope({
			status: "candidate_selected",
			result: {
				service_execution_id: response.service_execution_id,
				candidate: { rank: selection.rank, title: selection.title },
				...(continuation ? { checkout: continuation.checkout } : {}),
			},
			instruction: continuation
				? purchaseConfirmationInstruction(
					"candidate_selected",
					continuation.price,
					continuation.capability.delivery_email_required,
					continuation.capability.delivery_email_purpose,
					selection.title,
				)
				: "候选已绑定到来源 Execution；后续动作必须继续使用该 Execution。",
			next,
			recovery: [{
				command: `itpay services next ${response.service_execution_id} --json`,
				reason: "重新读取服务端允许的动作",
			}],
		}, {
			...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
			...(options.output ? { output: options.output } : {}),
		});
		return;
	}
	writeCommandEnvelope({
    status: "action_recorded",
    result: {
      service_execution_id: response.service_execution_id,
      action_type: response.action_type,
      action_status: response.status,
    },
    instruction: "动作已记录，读取服务端计算的新状态；不要自行假设下一 capability。",
    next: {
      command: `itpay services next ${response.service_execution_id} --json`,
      reason: "取得更新后的首选动作",
    },
    recovery: [],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
  });
}

async function resolveCandidateSelection(
  backend: BackendClient,
  serviceExecutionID: string,
  actionType: string,
	options: { candidateRank?: number; resultItemID?: string },
): Promise<{ resultItemID: string; rank: number; title: string } | undefined> {
  if (options.candidateRank === undefined) return undefined;
  if (actionType !== "select_candidate") {
    throw actionInputError(serviceExecutionID, "--candidate is only valid with --action select_candidate");
  }
  if (options.resultItemID) {
		throw actionInputError(serviceExecutionID, "--candidate cannot be combined with --result-item");
  }
  if (!Number.isInteger(options.candidateRank) || options.candidateRank < 1) {
    throw actionInputError(serviceExecutionID, "--candidate must be a positive integer result rank");
  }
  const execution = await backend.getServiceExecution(serviceExecutionID);
	const currentItems = execution.current_result_items ?? [];
	const result = currentItems.find((item) => item.rank === options.candidateRank);
  if (!result) {
    throw actionInputError(
      serviceExecutionID,
      `candidate ${options.candidateRank} is not available on service execution ${serviceExecutionID}`,
      "candidate_not_found",
    );
  }
	return {
		resultItemID: result.service_capability_result_item_id,
		rank: result.rank,
		title: result.display_title,
	};
}

function actionInputError(serviceExecutionID: string, message: string, code = "service_action_invalid"): CommandContractError {
  return new CommandContractError(
    code,
    message,
    code === "candidate_not_found"
			? "当前 rank 不存在或当前候选集不可用。不要新建 Execution，不要重新 invoke，不要构造候选 ID；只恢复同一 Execution 当前仍然有效的候选。"
			: "使用当前 safe result 中的合法 action 和 candidate rank；需要人确认时先询问用户。",
    [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "重新读取同一 Execution 的当前可选动作" }],
  );
}

export async function runServicesCheckout(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string | undefined,
  options: ServicesCommandOptions & {
    email?: string;
    deliveryContact?: Record<string, unknown>;
		lockedInput?: Record<string, unknown>;
    host?: ClientHost;
    target?: string;
    qrFormat?: DispatchOptions["qrFormat"];
    qrFilePath?: string;
    isTTY?: boolean;
    jsonOutput?: boolean;
    fetchImpl?: typeof fetch;
    agentType?: string;
    locale?: CardLocale;
    resume?: boolean;
    persistHandoff?: (handoff: {
      serviceExecutionID: string;
      cartID: string;
      checkoutID: string;
      displayToken: string;
      checkoutURL: string;
    }) => void;
  } = {},
): Promise<void> {
  const host = options.host ?? "terminal";
  const contextError = validateContext(host, options.target);
  if (contextError) {
    throw new CommandContractError(
      contextError.code,
      contextError.message,
      "从当前可信会话上下文补齐 Host/target；本次未创建 Checkout。",
      [],
    );
  }
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
  if (!options.resume && !capabilityID) {
    const model = await backend.getServiceExecution(serviceExecutionID);
    capabilityID = model.workflow_entry?.capability_id;
  }
  if (!options.resume && !capabilityID) {
    throw new CommandContractError(
      "capability_required",
      "--capability is required when creating a service checkout",
      "使用当前 Service Execution 返回的付费 capability；恢复已有 Checkout 时改用 --resume。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前允许的付费 capability" }],
    );
  }
  if (!options.resume) {
    const readModel = await backend.getServiceExecution(serviceExecutionID);
    const capability = readModel.capabilities.find((item) => item.capability_id === capabilityID);
    if (!capability || !capability.requires_payment) {
      throw new CommandContractError(
        "capability_not_checkoutable",
        `capability ${capabilityID} is not available for checkout on service execution ${serviceExecutionID}`,
        "只为当前 Service Execution 返回的 requires_payment capability 创建 Checkout。",
        [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前允许的下一步" }],
      );
    }
    const lockedInput = options.lockedInput ?? {};
    const missingInput = missingRequiredInput(capability.input_schema, lockedInput);
    if (missingInput.length > 0 && !readModel.workflow_entry && readModel.execution.next_action !== "create_checkout") {
      throw new CommandContractError(
        "capability_input_invalid",
        `missing required capability input: ${missingInput.join(", ")}`,
        "补齐付费 capability 的 required_input；本次没有创建 quote、Checkout 或订单。",
        [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template: { command: checkoutCommand(serviceExecutionID, capability, lockedInput), required_input: missingInput, executable: false } },
      );
    }
    if (capability.delivery_email_required && readModel.workflow_entry?.capability_id !== capability.capability_id && String(deliveryContact.email ?? "").trim() === "") {
      throw new CommandContractError(
        "delivery_email_required",
        "delivery email is required before creating this service checkout",
        "该 capability 的交付链接会发送到用户邮箱；先向用户说明用途并询问邮箱，不要代填。",
        [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template: { command: `itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)} --email <email> --json`, required_input: ["email"], executable: false } },
      );
    }
  }
  const response = await backend.createServiceExecutionCheckout(serviceExecutionID, {
    ...(capabilityID ? { capability_id: capabilityID } : {}),
    ...(Object.keys(deliveryContact).length > 0 ? { delivery_contact: deliveryContact } : {}),
		...(options.lockedInput && Object.keys(options.lockedInput).length > 0 ? { locked_input: options.lockedInput } : {}),
    ...(options.resume ? { resume: true } : {}),
  });
  const checkout = response.checkout;
  const checkoutID = checkout.checkout.checkout_id;
  const displayToken = checkout.display_token;
  const locale = normalizeCardLocale(options.locale);
  const checkoutURL = tokenizedCheckoutURL(checkout.checkout_url, displayToken, checkout.qr_payload);
  const cardURL = localizeCardURL(absolutePublicURL(
    config.baseURL,
    checkout.card_url ?? fallbackCardURL(config.baseURL, checkoutID, displayToken),
  ), locale);
  const cardPNGURL = localizeCardURL(absolutePublicURL(
    config.baseURL,
    checkout.card_png_url ?? checkout.qr_png_url ?? fallbackCardPNGURL(config.baseURL, checkoutID, displayToken),
  ), locale);
  let itineraryTitle: string | undefined;
  try {
    const booking = await backend.getServiceExecution(serviceExecutionID);
    if (booking.execution.service_id === "itpay-rail-booking") {
      const leg = booking.rail_booking?.legs?.[0];
      const review = booking.workflow?.human_action?.context?.review as Record<string, unknown> | undefined;
      const reviewLeg = Array.isArray(review?.legs) ? review.legs[0] as Record<string, unknown> | undefined : undefined;
      const facts = leg ?? reviewLeg;
      if (facts) {
        itineraryTitle = [facts.travel_date, facts.train_code,
          facts.from ?? (facts as Record<string, unknown>).from_station,
          "→", facts.to ?? (facts as Record<string, unknown>).to_station,
          facts.seat_name ?? (facts as Record<string, unknown>).seat_type_name]
          .filter((value) => typeof value === "string" && value.length > 0).join(" ");
      }
    }
  } catch {
    // Checkout already exists; a display-only title lookup cannot hide its official handoff.
  }
  const plan = buildCheckoutQRPlan({
    host,
    checkoutID,
    checkoutURL,
    cardURL,
    displayToken,
    qrPayload: checkout.qr_payload,
    qrPNGURL: cardPNGURL,
    nextAction: checkout.checkout.next_action,
    orderItems: response.cart.items.map((item) => ({
      title: itineraryTitle || item.title,
      quantity: item.quantity,
      amountMinor: item.amount_minor,
      currency: item.currency,
    })),
    orderCurrency: checkout.checkout.currency,
    ...(options.agentType ? { agentType: options.agentType } : {}),
    locale,
  });

  options.persistHandoff?.({
    serviceExecutionID,
    cartID: response.cart.cart_id,
    checkoutID,
    displayToken,
    checkoutURL,
  });

  const platform = platformKeyForHost(plan.host);
  if (!options.jsonOutput && (platform === "telegram" || platform === "feishu" || platform === "lark")) {
    await dispatchRender(plan, {
      host,
      ...(options.target ? { target: options.target } : {}),
      ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
      ...(options.qrFilePath ? { qrFilePath: options.qrFilePath } : {}),
      ...(options.output ? { output: options.output } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      baseURL: config.baseURL,
    });
    return;
  }
  if (shouldPrepareLocalCheckoutImage(platform)) {
    await ensureIdeImageAttach(plan, {
      enabled: config.ideImageAttach,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  const envelope = buildServicesCheckoutEnvelope(response, checkoutURL, plan, options.agentType, options.target);
  const plainResult = [
    `service_execution_id: ${response.binding.service_execution_id}`,
    `checkout_id: ${checkoutID}`,
    `capability_id: ${checkoutCapabilityID(response, capabilityID)}`,
    ...plainValueLines(plan.orderItems ?? [], "items"),
    `amount: ${formatMoney(checkout.checkout.amount_minor, checkout.checkout.currency)}`,
  ];
  if (!options.jsonOutput && platform === "terminal") {
    plainResult.push("qr:", await renderTerminalQR(checkoutURL, options.qrFormat ?? "terminal"));
  }
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult,
  });
}

export async function runServicesQuote(
  backend: BackendClient,
  serviceExecutionID: string,
  capabilityID: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & { email?: string; deliveryContact?: Record<string, unknown>; jsonOutput?: boolean } = {},
): Promise<void> {
  const model = await backend.getServiceExecution(serviceExecutionID);
  const capability = model.capabilities.find((item) => item.capability_id === capabilityID);
  if (!capability || !capability.requires_payment) {
    throw new CommandContractError(
      "capability_not_quoteable",
      `capability ${capabilityID} is not available for quote on service execution ${serviceExecutionID}`,
      "只为当前 Service Execution 返回的付费 capability 创建报价。",
      [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取当前合法动作" }],
    );
  }
  const selectionBacked = model.execution.status === "human_action_approved" &&
    model.allowed_actions?.some((action) => action.type === "prepare_quote" && action.capability_id === capabilityID);
  const missingInput = missingRequiredInput(capability.input_schema, input);
  if (missingInput.length > 0 && !selectionBacked && model.workflow_entry?.capability_id !== capability.capability_id) {
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "补齐付费 capability 输入；本次没有创建 Quote、Cart 或 Checkout。",
      [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template: { command: quoteCommand(serviceExecutionID, capability, input), required_input: missingInput, executable: false } },
    );
  }
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
  if (capability.delivery_email_required && model.workflow_entry?.capability_id !== capability.capability_id && String(deliveryContact.email ?? "").trim() === "") {
    throw new CommandContractError(
      "delivery_email_required",
      "delivery email is required before preparing this service quote",
      "交付链接会发送到用户邮箱；说明用途并询问邮箱，不要代填。",
      [], { schema_version: "itpay.interaction.v1", stage: "input_required", input_template: { command: quoteCommand(serviceExecutionID, capability, input), required_input: ["email"], executable: false } },
    );
  }
  const quote = await backend.prepareServiceQuote(serviceExecutionID, {
    capability_id: capabilityID,
    ...(Object.keys(deliveryContact).length > 0 ? { delivery_contact: deliveryContact } : {}),
    ...(Object.keys(input).length > 0 ? { locked_input: input } : {}),
  });
  const result = {
    service_quote_lock_id: quote.service_quote_lock_id,
    service_execution_id: quote.service_execution_id,
    capability_id: quote.capability_id,
    price: formatMoney(quote.amount_minor, quote.currency),
    expires_at: quote.expires_at,
  };
  writeCommandEnvelope({
    status: "quote_ready",
    result,
    instruction: "报价已锁定当前 Execution 的可信输入和价格；可单独付款，也可与其他独立 Execution 的报价合并。",
    next: {
      command: `itpay cart add --quote ${quote.service_quote_lock_id} --json`,
      reason: "加入 canonical Cart",
    },
    recovery: [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "重新读取当前 Execution 状态" }],
  }, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: Object.entries(result).map(([key, value]) => `${key}: ${String(value)}`),
  });
}

export async function runServicesGet(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.getServiceExecution(serviceExecutionID);
  const execution = response.execution;
  const timeline = response.events.slice(-20).map((event) => ({
    sequence: event.sequence,
    step: event.type,
    status: event.status,
    phase: event.phase,
    ...(event.capability_id ? { capability_id: event.capability_id } : {}),
    occurred_at: event.occurred_at,
  }));
  const deliveryMode = serviceDeliveryMode(response);
  const lockedRefund = response.refunds.find((refund) => refund.access_locked);
  const nextState = servicesNextEnvelope(response);
  const result: Record<string, unknown> = {
    ...nextState.result,
    service_execution_id: execution.service_execution_id,
    service_id: execution.service_id,
    status: execution.status,
    phase: execution.phase,
    ...(execution.current_capability_id ? { current_capability_id: execution.current_capability_id } : {}),
    updated_at: execution.updated_at,
    timeline,
    ...(response.workflow ? { workflow: response.workflow } : {}),
    ...(response.rail_booking ? { rail_booking: response.rail_booking } : {}),
    ...(response.events.length > timeline.length ? { timeline_truncated: true } : {}),
    ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
    ...(lockedRefund ? {
      access_locked: true,
      refund: { refund_request_id: lockedRefund.refund_request_id, status: lockedRefund.status },
    } : {}),
  };
  const envelope: CommandEnvelope = {
    status: nextState.status,
    result,
    instruction: nextState.instruction,
    next: nextState.next,
    ...(nextState.interaction ? { interaction: nextState.interaction } : {}),
    ...(nextState.communication ? { communication: nextState.communication } : {}),
    ...(nextState.handoff ? { handoff: nextState.handoff } : {}),
    recovery: nextState.recovery.filter(action => action.command !== `itpay services get ${serviceExecutionID} --json`),
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: [
      `service_execution_id: ${execution.service_execution_id}`,
      `service_id: ${execution.service_id}`,
      `state: ${execution.status}/${execution.phase}`,
      ...(execution.current_capability_id ? [`current_capability_id: ${execution.current_capability_id}`] : []),
      ...timeline.map((event) => `${event.sequence}. ${event.step} ${event.status}/${event.phase} ${event.occurred_at}`),
    ],
  });
}

function shouldWaitForServiceResult(model: ServiceExecutionReadModel): boolean {
  if (model.current_delivery || model.rail_booking || isTerminalServiceExecutionStatus(model.execution.status)) return false;
  if (model.rail_planning) {
    const plan = model.rail_planning;
    return !plan.recommendation && !(plan.alternatives?.length) &&
      !["complete", "paused", "failed", "cancelled", "expired"].includes(plan.search?.expansion_status ?? "") &&
      !plan.available_actions?.some((action) => ["select_journey", "confirm_location", "expand_search"].includes(action.type));
  }
  return ["queued", "running", "delivery"].includes(model.workflow?.status ?? "");
}

export async function runServicesNext(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean; sinceSnapshot?: string; timeoutSeconds?: number; pollIntervalMS?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<void> {
  const started = Date.now();
  const until = started + (options.timeoutSeconds ?? 0) * 1000;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let response = await backend.getServiceExecution(serviceExecutionID, options.sinceSnapshot ? { sinceSnapshot: options.sinceSnapshot } : {});
  while (shouldWaitForServiceResult(response) && Date.now() < until) {
    await sleep(options.pollIntervalMS ?? Math.max(1500, response.rail_planning?.search?.poll_after_ms ?? 0));
    response = await backend.getServiceExecution(serviceExecutionID, options.sinceSnapshot ? { sinceSnapshot: options.sinceSnapshot } : {});
  }
  const envelope = servicesNextEnvelope(response);
  if (shouldWaitForServiceResult(response) && options.timeoutSeconds) {
    envelope.result = { ...envelope.result, waited_seconds: Math.round((Date.now() - started) / 1000), wait_timed_out: true };
    envelope.next = { command: `itpay services next ${serviceExecutionID} --timeout 120 --json`, reason: "稍后继续等待同一任务；不重新提交查询" };
  }
  journalTaskState(serviceExecutionID, envelope, options.env ?? process.env);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: servicesNextPlainResult(envelope.result),
  });
}

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
  const response = await backend.getServiceExecutionResultItemPage(serviceExecutionID, resultItemID, offset, limit);
  const page = response.page;
  const container = (page.result ?? page) as Record<string, unknown>;
  const exactCandidate = limit === 1 && Array.isArray(container.candidates) && container.candidates.length === 1
    ? container.candidates[0] as Record<string, unknown> : undefined;
  if (exactCandidate && typeof exactCandidate.train_code === "string" && Array.isArray(exactCandidate.seats)) {
    const offer = exactCandidate.booking_offer as { service_id?: string; selection_token?: string } | undefined;
    const { booking_offer: _bookingOffer, ...candidateFacts } = exactCandidate;
    const seats = (exactCandidate.seats as Record<string, unknown>[]).filter((seat) => seat.purchase_supported === true);
    const seat = seats[0];
    writeCommandEnvelope({
      status: "exact_train_detail",
      result: {
        service_execution_id: serviceExecutionID, result_item_id: resultItemID, result_offset: offset,
        candidate: candidateFacts,
        ...(offer?.service_id && offer.selection_token ? { booking_template: {
          command: `itpay services run ${offer.service_id} --input-json <file> --json`,
          executable: false, required_input: ["file", "passengers", "seat_type"],
          seat_choices: seats.map((choice) => ({ seat_type: choice.seat_type, seat_name: choice.seat_name })),
          input_example: { selection: { token: offer.selection_token, ...(typeof seat?.seat_type === "string" ? { seat_type: seat.seat_type } : {}) }, passengers: 1 },
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
      count: catalogPage.count ?? candidates.length,
      next_offset: nextOffset,
      ...(journeys.length ? { journeys: journeys.map(value => compactRailJourney(value as RailJourneyCard, serviceExecutionID, resultItemID)) }
        : candidates.some(value => typeof value === "object" && value !== null && "train_code" in value)
          ? { candidates: candidates.map(value => compactExactTrain(value as Record<string, unknown>)) } : { page }),
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

// Bound the final qualified output by whole saved rows; the cursor follows the emitted rows.
function writeSavedRailPage(envelope: CommandEnvelope, options: ServicesCommandOptions & { all?: boolean },
  key: "trains" | "journeys", offset: number, continuation: (offset: number) => CommandAction): void {
  const result = envelope.result ?? {};
  const rows = result[key];
  if (!Array.isArray(rows)) throw new Error("saved page has no rows");
  const bound = (offset === 0 ? 12 : 32) * 1024;
  const render = (output: OutputSink) => writeCommandEnvelope(envelope, { ...options, output });
  if (!options.all) {
    for (;;) {
      let text = "";
      render(value => { text += value; });
      if (Buffer.byteLength(text, "utf8") <= bound) break;
      if (rows.length <= 1) {
        throw new CommandContractError("saved_row_too_large", "saved row exceeds the readable page limit",
          "这条已保存记录超过当前页面大小；事实仍保留，请读取该条详情。", rows[0]?.detail?.command ? [rows[0].detail] : []);
      }
      rows.pop();
      result.count = rows.length;
      if (key === "trains") result.read_count = rows.length;
      result.next_offset = offset + rows.length;
      envelope.next = continuation(offset + rows.length);
    }
  }
  writeCommandEnvelope(envelope, options);
}

export async function runServicesReadResult(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean; snapshot?: string; journey?: string; offset?: number; limit?: number; all?: boolean } = {},
): Promise<void> {
  if (!options.snapshot && !options.journey) {
    const model = await backend.getServiceExecution(serviceExecutionID);
    if (model.execution.service_id === "itpay-rail-exact") {
      const item = (model.current_result_items?.length ? model.current_result_items : model.result_items)?.[0];
      if (!item) {
        const preview = model.provider_invocations.at(-1)?.safe_result_preview as Record<string, unknown> | undefined;
        const template = exactSmartTemplate(preview?.resolved_station_pair, serviceExecutionID);
        if (template && preview?.catalog_total === 0) {
          writeCommandEnvelope({ status: "no_result", result: { service_execution_id: serviceExecutionID,
            scope: "station_pair", resolved_station_pair: preview.resolved_station_pair,
            total: 0, smart_template: template },
            instruction: "这一站对的成功观测为0条，不代表附近区域无车。若用户允许中转或原需求范围更广，保留原始区域/地点意图并沿 smart_template 引用本次事实；只要直达时不要自动转中转。",
            next: null, recovery: [] }, { ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
              ...(options.output ? { output: options.output } : {}) });
          return;
        }
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
        const container = (response.page.result ?? response.page) as Record<string, unknown>;
        const candidates = Array.isArray(container.candidates) ? container.candidates : [];
        resolvedStationPair ??= container.resolved_station_pair;
        rows.push(...candidates.map((value, index) => ({
          ...compactExactTrain(value as Record<string, unknown>),
          result_item_id: item.service_capability_result_item_id,
          result_offset: offset + index,
          detail: { command: `itpay services page ${serviceExecutionID} ${item.service_capability_result_item_id} --offset ${offset + index} --limit 1 --json`,
            reason: "读取此车次的当前席别与服务端购买凭据" },
        })));
        const page = (container.catalog_page ?? {}) as { next_offset?: number | null };
        total = typeof container.catalog_total === "number" ? container.catalog_total : Math.max(total, rows.length);
        nextOffset = typeof page.next_offset === "number" && page.next_offset > offset ? page.next_offset : null;
        offset = nextOffset ?? offset;
      } while (options.all && nextOffset !== null);
      writeSavedRailPage({
        status: "ready",
        result: { service_execution_id: serviceExecutionID, scope: "station_pair", resolved_station_pair: resolvedStationPair,
          total, offset: startOffset, count: rows.length, read_count: rows.length,
          ...(exactSmartTemplate(resolvedStationPair, serviceExecutionID, item.service_capability_result_item_id)
            ? { smart_template: exactSmartTemplate(resolvedStationPair, serviceExecutionID, item.service_capability_result_item_id) } : {}),
          trains: rows, ...(nextOffset !== null ? { next_offset: nextOffset } : {}) },
        instruction: "这是同一已保存站对的车次行。按用户时限、席别和人数筛选；零条仅代表这一站对。纯比较答复后结束；已有购票委托则执行所选行 detail.command 读取当前席别、库存和购买凭据。",
        next: nextOffset !== null ? { command: `itpay services read-result ${serviceExecutionID} --offset ${nextOffset} --limit ${limit} --json`, reason: "继续读取同一结果的剩余车次" } : null,
        recovery: [],
      }, { ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
        ...(options.output ? { output: options.output } : {}),
        all: Boolean(options.all),
      }, "trains", startOffset, next => ({ command: `itpay services read-result ${serviceExecutionID} --offset ${next} --limit ${limit} --json`, reason: "读取同一保存结果的下一页" }));
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
    let qualificationCounts: { eligible: number; ineligible: number; unknown: number } | undefined;
    let planID: string | undefined;
    let queryRevision: number | undefined;
    while (nextOffset !== null) {
      let response: Awaited<ReturnType<BackendClient["getServiceExecutionResultItemPage"]>>;
      try {
        response = await backend.getServiceExecutionResultItemPage(serviceExecutionID, options.snapshot, nextOffset, limit);
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
      const container = (response.page.result ?? response.page) as Record<string, unknown>;
      const page = container.journey_page as { total?: number; next_offset?: number | null;
        qualification_counts?: { eligible: number; ineligible: number; unknown: number } } | undefined;
      const rows = Array.isArray(container.journeys) ? container.journeys as RailJourneyCard[] : [];
      total = typeof page?.total === "number" ? page.total : rows.length;
      qualificationCounts = page?.qualification_counts ?? qualificationCounts;
      journeys.push(...rows.map((card) => compactRailJourney(card, serviceExecutionID, options.snapshot!)));
      const following = page?.next_offset;
      if (typeof following === "number" && following <= nextOffset) throw new Error("saved page cursor did not advance");
      nextOffset = typeof following === "number" ? following : null;
      if (!options.all) break;
    }
    writeSavedRailPage({
      status: "ready",
      result: {
        service_execution_id: serviceExecutionID,
        plan_id: planID,
        snapshot_id: options.snapshot,
        query_revision: queryRevision,
        total,
        qualification_counts: qualificationCounts,
        offset,
        count: journeys.length,
        next_offset: nextOffset,
        journeys,
      },
      instruction: qualificationCounts === undefined
        ? "此历史快照没有完整资格计数；线路仅供核对铁路事实，不能据此认定可购买。沿同快照 detail.command 查看详情。"
        : qualificationCounts.eligible === 0
        ? `查到 ${total} 个时刻组合，当前 0 条满足购票资格。请读取诊断线路的 detail.command 查看具体原因；修改条件须依据用户意愿。`
        : "这是同一已保存快照的完整线路分页；合格线路已排在前面。若问题需要全部方案，沿 next.command 读完再一次回答；未知费用不能当免费。购票条件用合格线路的 detail.command，价格与余票在购买前实时报价。",
      next: nextOffset === null ? null : { command: `itpay services read-result ${serviceExecutionID} --snapshot ${options.snapshot} --offset ${nextOffset} --limit ${limit} --json`, reason: "读取同一快照的下一页线路" },
      recovery: [],
    }, {
      ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
      ...(options.output ? { output: options.output } : {}),
      all: Boolean(options.all),
    }, "journeys", offset, next => ({ command: `itpay services read-result ${serviceExecutionID} --snapshot ${options.snapshot} --offset ${next} --limit ${limit} --json`, reason: "读取同一快照的下一页线路" }));
    return;
  }
  if (options.journey) {
    const detail = await backend.getRailJourneyDetail(serviceExecutionID, options.journey, options.snapshot);
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
        ticket_plans: selected.map(compactRailTicketPlan),
      },
      instruction: "同一线路的完整车次和分页席别方案；报价只是参考价，购买前须受保护 Checkout 实时报价。若仍有席别方案，沿 next.command 读取。代选与真人选择按用户真实授权区分。",
      next: nextOffset === null ? null : { command: `itpay services read-result ${serviceExecutionID} --snapshot ${detail.snapshot_id} --journey ${options.journey} --offset ${nextOffset} --limit ${planLimit} --json`, reason: "读取此行程余下席别方案" },
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

function exactSmartTemplate(pair: unknown, executionID: string, resultItemID?: string): Record<string, unknown> | null {
  if (!pair || typeof pair !== "object") return null;
  const value = pair as Record<string, unknown>;
  if (!["origin_name", "origin_code", "destination_name", "destination_code", "travel_date"].every((key) => typeof value[key] === "string" && value[key])) return null;
  return { endpoints: { origin: { kind: "station", text: value.origin_name, station_code: value.origin_code },
    destination: { kind: "station", text: value.destination_name, station_code: value.destination_code } },
    travel_date: value.travel_date, reuse_from: { execution_id: executionID,
      ...(resultItemID ? { result_item_id: resultItemID } : {}) } };
}

function compactExactTrain(candidate: Record<string, unknown>): Record<string, unknown> {
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

function railLegSeatSummary(seat: { passenger_index: number; seat_type_name?: string; seat_label?: string; coach_no?: string; seat_no?: string; confirmed: boolean }) {
  return {
    passenger_index: seat.passenger_index,
    ...(seat.seat_type_name ? { seat_type_name: seat.seat_type_name } : {}),
    ...(seat.seat_label || seat.coach_no || seat.seat_no
      ? { seat: seat.seat_label ?? [seat.coach_no ? `${seat.coach_no}车` : "", seat.seat_no ?? ""].join("") }
      : {}),
    confirmed: seat.confirmed,
  };
}

function railBookingEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const rail = model.rail_booking!;
  const execution = model.execution;
  const orderID = (model.current_delivery ?? model.delivery_bindings.at(-1))?.order_id;
  const legs = rail.legs.map((leg) => ({
    leg_index: leg.leg_index,
    state: leg.state,
    issued: leg.issued,
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
    rail: { state: rail.state, issued_legs: rail.issued_legs, legs },
  };
  if (rail.state === "issued") {
    const detailsPending = rail.legs.some((leg) => leg.details_pending);
    return {
      status: "issued",
      result,
      instruction: `告诉用户：车票已出票，座位以实际出票为准，平台不提供 12306 票号，可在订单页核对行程。不要在对话中索要乘车人身份信息。${detailsPending ? "部分席位信息未能同步，请前往 12306 核对行程；不要重复购买。" : ""}`,
      next: orderID ? { command: `itpay order ${orderID} --json`, reason: "查看订单及退款入口" } : null,
      recovery: [],
    };
  }
  if (rail.state === "manual_review") {
    return {
      status: "manual_review",
      result,
      instruction: "告诉用户：付款已确认，订单需要人工核对；请勿重复付款或重新下单，已出票的车票会保留。不要承诺退款结果或时效。",
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
      instruction: "告诉用户：付款已确认，后台正在出票；付款成功不代表已出票，请勿重复购买或再次付款。稍后只读取同一任务。",
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

function compactRailJourney(card: RailJourneyCard, serviceExecutionID: string, snapshotID: string): Record<string, unknown> {
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
  const railwayTime = (value: unknown) => {
    if (typeof value !== "string") return NaN;
    const time = value.replace(" ", "T");
    return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(time) ? time : `${time}Z`);
  };
  const start = railwayTime(rides[0]?.departure);
  const end = railwayTime(rides.at(-1)?.arrival);
  return {
    journey_ref: card.journey_id,
    ...(card.profile_refs?.balanced ? { profile_ref: card.profile_refs.balanced } : {}),
    default_layer: card.default_layer ?? "main",
    ...(card.backup_reason ? { backup_reason: card.backup_reason } : {}),
    ...(card.backup_baseline_min != null ? { backup_baseline_min: card.backup_baseline_min } : {}),
    ...(card.backup_delta_min != null ? { backup_delta_min: card.backup_delta_min } : {}),
    route: card.route_text ?? (card.route_names ?? card.route ?? []).join("→"),
    rides,
    ...(ticketSeats.length ? { seats: ticketSeats } : {}),
    passengers: card.passengers ?? offer?.ticket_offers?.[0]?.passengers ?? null,
    availability: card.availability ?? "unknown",
    qualification_status: card.qualification_status ?? "unknown",
    ...(card.qualification_reasons?.length ? { qualification_reasons: card.qualification_reasons } : {}),
    ...(offer ? { rail_payable_fen: offer.rail_payable_minor, currency: offer.currency } : { rail_payable_fen: null }),
    estimated_trip_total: metrics?.estimated_total_cost ?? null,
    cost_basis: metrics?.cost_basis ?? "unknown",
    duration_basis: metrics?.duration_basis ?? "unknown",
    timezone: "Asia/Shanghai",
    ...(card.risk_notes?.length ? { risk_notes: card.risk_notes } : {}),
    rail_duration_minutes: Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 60000) : null,
    ...(card.observed_at ? { observed_at: card.observed_at } : {}),
    detail: { command: `itpay services read-result ${serviceExecutionID} --snapshot ${snapshotID} --journey ${card.journey_id} --json`,
      reason: card.qualification_status === "eligible" ? "读取此完整线路的席别、报价和购买条件" : "读取此线路的铁路事实和不可购买原因" },
  };
}

function compactRailTicketPlan(raw: Record<string, unknown>): Record<string, unknown> {
  const legs = Array.isArray(raw.legs) ? raw.legs as Record<string, unknown>[] : [];
  const seats = Array.isArray(raw.seat_offers) ? raw.seat_offers as Record<string, unknown>[][] : [];
  return {
    ticket_plan_ref: raw.ticket_plan_ref,
    passengers: raw.passenger_count ?? (Array.isArray(raw.ticket_offers) ? (raw.ticket_offers[0] as Record<string, unknown> | undefined)?.passengers : null) ?? null,
    purchase_support: raw.purchase_support ?? "none",
    qualification_status: raw.qualification_status ?? "unknown",
    qualification_reasons: raw.qualification_reasons ?? [],
    rail_amount_fen: raw.rail_amount_fen ?? null,
    service_fee_fen: raw.service_fee_fen ?? null,
    price_verified: raw.rail_amount_verified === true,
    legs: legs.map((leg, index) => ({
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

function railJourneySummary(card: RailJourneyCard, serviceExecutionID: string, snapshotID?: string): Record<string, unknown> {
  const rides = Array.isArray(card.rides) ? card.rides : [];
  const trains = rides.map((ride: Record<string, unknown>) => ride.train_code).filter(Boolean);
  const first = rides[0] as Record<string, unknown> | undefined;
  const last = rides.at(-1) as Record<string, unknown> | undefined;
  const offer = card.representative_offer;
  const metrics = card.representative_metrics;
  return {
    journey_id: card.journey_id,
    ...(snapshotID ? (() => { const detail = compactRailJourney(card, serviceExecutionID, snapshotID); return { rides: detail.rides, seats: detail.seats, default_layer: detail.default_layer, detail: detail.detail }; })() : {}),
    route: (card.route_names?.length ? card.route_names : card.route ?? []).join("→"),
    ...(trains.length ? { trains } : {}),
    ...(first?.departure || last?.arrival ? { time: `${first?.departure ?? ""}–${last?.arrival ?? ""}` } : {}),
    ...(offer ? { price: formatMoney(offer.rail_payable_minor, offer.currency) } : { price: "unknown" }),
    ...(metrics ? { calculation_scope: {
      origin: metrics.origin_scope ?? "legacy_unknown", destination: metrics.destination_scope ?? "legacy_unknown",
      duration_basis: metrics.duration_basis ?? "legacy_unknown", arrival_basis: metrics.arrival_basis ?? "legacy_unknown",
      cost_basis: metrics.cost_basis ?? "legacy_unknown",
      duration_minutes: metrics.door_to_door_min ?? null,
    } } : {}),
    ...(card.decision_role ? { decision_role: card.decision_role } : {}),
    ...(card.explanation?.length ? { explanation: card.explanation } : {}),
    ...(card.reason_codes?.length ? { reason_codes: card.reason_codes } : {}),
    ...(card.tradeoff_codes?.length ? { tradeoff_codes: card.tradeoff_codes } : {}),
    ...(card.recommended_profile ? { recommended_profile: card.recommended_profile,
      price_basis: "price为默认购票方案参考价；推荐对应的席别、接驳及总价以recommended_profile为准，按其中ticket_plan_ref/offer_refs查看并确认后下单。" } : {}),
    availability: card.availability,
    booking_support: card.booking_support,
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
function railPlanningEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
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
    ...(plan.snapshot_id ? { full_result: { command: `itpay services read-result ${se} --snapshot ${plan.snapshot_id} --json`, meaning: "读取已保存的完整目录；推荐和journeys仅是摘要" } } : {}),
    ...(!hasEligible && ["paused", "complete", "expired"].includes(expansion) && plan.query_input && plan.catalog_snapshot_id ? { new_query_template: {
      command: "itpay services run itpay-rail-smart --input-json <file> --json",
      executable: false,
      input_example: { ...plan.query_input, reuse_from: { execution_id: se, snapshot_id: plan.catalog_snapshot_id } },
      meaning: "先取得真实范围变更同意，再复制完整input_example，仅改获准端。换具体站用station及匹配名称/站码；考虑原站周边用place及原站名，删除station_code，经正常地点解析或使用已核实POI/坐标；只有明确同意整个市才用area及完整行政名，删除POI/坐标/站码。日期、人数、时限及偏好保持；新执行不改变旧查询或订单。引用仅限同owner未过期事实，跨owner拒绝；日期变更不复用旧库存。",
    } } : {}),
    ...(plan.available_actions?.length ? { available_actions: plan.available_actions } : {}),
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
          instruction: "已查到铁路班次，但具体地址的接驳或出站证据不足，无法验证到达时限；剩余站对未继续查询，不能说没有车。向用户说明已查范围，并请其补充准确起终点地址或可验证的接驳/出站信息；取得新事实后再按其要求重新规划，不要默认扩大铁路搜索。",
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

function terminalExecutionEnvelope(model: ServiceExecutionReadModel): CommandEnvelope | null {
  const execution = model.execution;
  const currentDelivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  if (!isTerminalServiceExecutionStatus(execution.status) ||
      (model.workflow_entry && (currentDelivery || serviceDeliveryMode(model) === "agent_visible_result") && ["completed", "delivery_completed"].includes(execution.status))) {
    return null;
  }
  const paid = model.checkout_bindings.some((binding) => binding.status === "payment_verified") || Boolean(currentDelivery?.order_id);
  const paidFailure = execution.status === "failed" && paid;
  return {
    status: execution.status,
    result: {
      service_execution_id: execution.service_execution_id,
      service_id: execution.service_id,
      phase: execution.phase,
      ...(currentDelivery?.order_id ? { order_id: currentDelivery.order_id } : {}),
    },
    instruction: execution.status === "refunded"
      ? "告诉用户这笔服务已经退款并永久结束。Agent 不重放服务步骤、不创建付款页面或尝试读取旧交付。"
      : paidFailure
        ? appendFeedbackPostmortemInstruction("告诉用户：付款和订单已经记录，但本次服务没有正常完成，不需要再次付款或重新下单。然后从同一订单检查退款状态；Agent 不重放服务步骤、创建付款页面或再次调用数据来源，也不把技术故障归咎于用户。", "failed")
        : "告诉用户本次服务已经结束且没有可继续的交付。Agent 不重放服务步骤或创建付款页面。",
    next: null,
    recovery: [
      ...(paidFailure
        ? [{
            command: currentDelivery?.order_id
              ? `itpay order ${currentDelivery.order_id} --json`
              : "itpay orders --json",
            reason: "恢复同一笔已付款订单及其退款状态",
          }]
        : []),
      {
        command: `itpay services events ${execution.service_execution_id} --json`,
        reason: "仅在需要诊断终止原因时读取事件",
      },
    ],
  };
}

function servicesNextEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const execution = model.execution;
  const currentDelivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  const lockedRefund = model.refunds.find((refund) => refund.access_locked);
  if (lockedRefund) {
    const terminal = lockedRefund.status === "succeeded";
    return {
      status: "delivery_locked",
      result: {
        service_execution_id: execution.service_execution_id,
        access_locked: true,
        refund: {
          refund_request_id: lockedRefund.refund_request_id,
          status: lockedRefund.status,
        },
      },
      instruction: terminal
        ? "告诉用户退款已由 ItPay 确认成功，原交付永久关闭。Agent 停止读取和跟踪，不再创建授权。"
        : "告诉用户退款仍在处理，原交付已按政策冻结。然后读取同一退款的权威状态；Agent 不读取交付、不创建授权或重复申请。",
      next: terminal ? null : {
        command: `itpay refund get ${lockedRefund.refund_request_id} --json`,
        reason: "读取退款权威状态",
      },
      recovery: [],
    };
  }
  const latestRun = model.execution_requests?.filter((request) => request.execution_kind === "service.execution.run").at(-1);
  if (latestRun && ["pending", "started"].includes(latestRun.status)) {
    return {
      status: "running",
      result: { service_execution_id: execution.service_execution_id, execution_request_id: latestRun.execution_request_id },
      instruction: "任务仍在排队或执行中，稍后读取同一任务。不要重新查票、重复提交输入或把等待状态当作零结果。",
      next: { command: `itpay services next ${execution.service_execution_id} --json`, reason: "稍后读取同一任务状态" },
      recovery: [],
    };
  }
  // A terminal execution wins over the rail read model: a failed, cancelled,
  // or refunded run must not render as still issuing. Completed executions
  // keep the rail view so issued seats stay visible.
  if (model.rail_booking && isTerminalServiceExecutionStatus(execution.status) && !["completed", "delivery_completed"].includes(execution.status)) {
    const terminal = terminalExecutionEnvelope(model);
    if (terminal) return terminal;
  }
  if (model.rail_booking) return railBookingEnvelope(model);
  if (model.rail_planning) return railPlanningEnvelope(model);
  if (latestRun && ["failed", "cancelled"].includes(latestRun.status) && !model.workflow_entry) {
    return {
      status: latestRun.status,
      result: { service_execution_id: execution.service_execution_id },
      instruction: "本次任务未完成，需要检查同一任务的处理记录；这不表示没有结果。不要自动重新发起。",
      next: null,
      recovery: [{ command: `itpay services events ${execution.service_execution_id} --json`, reason: "读取同一任务的处理记录" }],
    };
  }
  if (model.workflow_entry && !["completed", "delivery"].includes(model.workflow?.status ?? "")) {
    const id = execution.service_execution_id;
    const paymentVerified = model.payment_bindings.some((binding) => binding.status === "payment_verified") || model.checkout_bindings.some((binding) => binding.status === "payment_verified");
    const state = model.workflow?.status === "payment" && paymentVerified ? "running" : model.workflow?.status ?? "input_required";
    if (["quota_paused", "failed"].includes(state) && model.workflow?.error_code !== "area_scope_too_broad" && (model.workflow?.dependency ||
      ["amap_request_failed", "amap_rate_limited", "amap_qps_exceeded", "amap_quota_exceeded", "amap_daily_quota_exceeded", "amap_service_forbidden", "amap_ip_forbidden", "amap_key_invalid", "amap_parameter_invalid", "amap_web_service_key_not_configured"].includes(model.workflow?.error_code ?? ""))) {
      const dependency = model.workflow?.dependency;
      const resumable = state === "quota_paused" && dependency?.retryable === true;
      return {
        status: "dependency_unavailable",
        result: { service_execution_id: id, service_id: execution.service_id, reason: model.workflow?.error_code, ...(dependency ? {dependency} : {}) },
        instruction: resumable
          ? "地图服务暂时限流。保留原条件及已解析端点；到 retry_at 后执行下一步，继续同一任务，不重新提交地点。"
          : "地图服务本轮未完成解析，这是外部依赖故障，不要求用户换地址或自行找坐标。有界尝试已结束；保留原条件及已有结果，交由服务维护方处理该错误。",
        next: resumable ? {command: `itpay services run ${execution.service_id} --execution ${id} --json`, reason: "等待所示恢复时间后继续同一执行"} : null,
        recovery: [],
      };
    }
    if (state === "failed" && model.workflow?.error_code === "area_scope_too_broad") {
      return {status:"awaiting_input",result:{service_execution_id:id,reason:"area_scope_too_broad", affected_endpoint:model.workflow.dependency?.endpoint, input_template:{endpoints:{[model.workflow.dependency?.endpoint ?? "<受影响侧>"]:{kind:"area",text:"<市县镇完整名称>"}}}},
        instruction:"区域范围是省或国家。只补充受影响端点的市、县或镇；保留另一端、日期与用户约束。修正模板：endpoints.<受影响侧>={kind:area,text:<市县镇完整名称>}。",
        next:null,recovery:[]};
    }
    if (state === "failed" && ["address_required", "administrative_area_unresolved", "station_location_evidence_required", "coordinate_identity_unverified"].includes(model.workflow?.error_code ?? "")) {
      const code = model.workflow!.error_code!;
      return {
        status: "awaiting_input",
        result: { service_execution_id: id, service_id: execution.service_id, reason: code },
        instruction: code === "station_location_evidence_required"
          ? "尚未查票。车站身份已知，Smart 缺少车站坐标证据；请说明此系统缺口，不要求用户换站。双锁站直达可另用 Exact。"
          : code === "coordinate_identity_unverified"
          ? "尚未查票。名称与提交坐标缺少一致证据；请核实受影响端点的准确地点，保留其余出行条件。"
          : "尚未查票。地点缺少必要地址或行政归属；只请用户补充受影响端点，保留另一端及原条件。",
        next: null, recovery: [],
      };
    }
    if (state === "failed" && ["login_required", "rate_limited"].includes(model.workflow?.error_code ?? "")) {
      const login = model.workflow?.error_code === "login_required";
      return {
        status: login ? "login_required" : "rate_limited",
        result: {service_execution_id: id, service_id: execution.service_id},
        instruction: login ? "匿名免费额度已用完。使用官方网页登录并绑定当前 Agent，完成后重新发起查询；不需要付款。" : "已达到登录账号每分钟查询上限。请等到下一分钟再发起查询，不要连续重试。",
        next: login ? {command: "itpay auth login --json", reason: "登录继续免费查询"} : null,
        recovery: [],
      };
    }
    if (state === "quota_paused") {
      const login = model.workflow?.error_code !== "rate_limited";
      const resume = {command: `itpay services run ${execution.service_id} --execution ${id} --json`, reason: "登录或限流窗口后继续同一执行"};
      const quota = model.quota ? {bucket: model.quota.bucket, subject_type: model.quota.subject_type, limit: model.quota.limit, remaining: model.quota.remaining} : undefined;
      return {
        status: login ? "login_required" : "rate_limited",
        result: {service_execution_id: id, service_id: execution.service_id, ...(quota ? {quota} : {})},
        instruction: login ? "匿名免费额度已用完。使用 itpay auth login 完成官方登录并绑定当前 Agent，然后继续同一执行；不要重新发起查询，不需要付款。" : "已达到登录账号每分钟查询上限。请等到下一分钟后继续同一执行，不要连续重试。",
        next: login ? {command: "itpay auth login --json", reason: "登录后继续同一查询执行"} : resume,
        recovery: [resume],
      };
    }
    if (state === "human_action" && model.workflow?.human_action) {
      const action = model.workflow.human_action;
      const requiredFields = requiredInputFields(action.input_schema);
      const rawPlaces = action.context?.places;
      // Only the location-confirmation action carries origin/destination places;
      // every other human action keeps the generic envelope.
      const isLocationConfirmation = !!rawPlaces && typeof rawPlaces === "object" &&
        ("origin" in rawPlaces || "destination" in rawPlaces);
      if (isLocationConfirmation) {
        const places = rawPlaces as Record<string, {
          resolution_status?: string;
          resolution_reason?: string;
          formatted_address?: string; poi_name?: string; query?: string; location?: number[]; poi_type?: string;
          resolution_candidates?: Array<{ id?: string; poi_name?: string; query?: string; formatted_address?: string; location?: number[]; poi_type?: string; type?: string }>;
        }>;
        const sides = ["origin", "destination"].map((side) => {
          const place = places[side];
          const candidates = Array.isArray(place?.resolution_candidates) ? place.resolution_candidates : [];
          const name = (item: { poi_name?: string; query?: string; formatted_address?: string }) =>
            item.poi_name ?? item.query ?? item.formatted_address;
          return {
            side,
            status: place?.resolution_status,
            ...(place?.resolution_reason ? { reason: place.resolution_reason } : {}),
            ...(place?.resolution_status === "resolved"
              ? { resolved_place: { name: name(place), location: place.location } }
              : {}),
            ...(candidates.length
              ? { candidates: candidates.slice(0, 3).map((item, index) => ({ id: item.id ?? `${side}_${index + 1}`, name: name(item), address: item.formatted_address, type: item.poi_type ?? item.type, location: item.location })) }
              : {}),
          };
        });
        return {
          status: "confirmation_required",
          result: { service_execution_id: id, service_id: execution.service_id,
            human_action: { action_type: action.action_type, input_schema: action.input_schema },
            required_fields: requiredFields, sides },
          instruction: sides.some(side => side.status !== "resolved" && !side.candidates?.length)
            ? "尚未查票；未解析端点没有可选候选。说明该端点返回的证据不足原因，只补缺失地址或行政归属；外部依赖故障沿同执行恢复，不让用户任选或扩大范围。已解析端点保留。"
            : requiredFields.includes("choices")
            ? "尚未查票。仅向用户展示有真实歧义端点的候选名称、地址及 id；用户选定后，把各未解析端点的候选 id 放入 choices 对象，继续同一执行。已解析端点无需再选；不得替用户决定，也不是购买确认。"
            : "向用户展示有歧义一端的候选；按 required_fields 填写真实选择，已解析一端保留原值。继续同一执行；这不是购买确认。",
          next: null,
          interaction: {
            schema_version: "itpay.interaction.v1",
            stage: "location_confirmation_required",
            input_template: {
              command: requiredFields.includes("choices")
                ? `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved --input choices='<未解析端点到候选id的JSON对象>' --json`
                : `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved${requiredFields.map((field) => ` --input ${field}=<值>`).join("")} --json`,
              required_input: requiredFields,
              executable: false,
            },
          },
          recovery: [],
        };
      }
      const review = action.context?.review as Record<string, unknown> | undefined;
      if (review) {
        // W4: when the owner projects an official web review entry, present it
        // and wait for the human there; otherwise keep the one consolidated
        // chat review — never fabricate an accepted review.
        const reviewURL = [review.web_review_url, review.entry_url, review.review_url]
          .find((value): value is string => typeof value === "string" && /^https:\/\//.test(value));
        const requirementsRemaining = Array.isArray(review.requirements_remaining)
          ? review.requirements_remaining
          : undefined;
        return {
          status: "booking_review_required",
          result: { service_execution_id: id, service_id: execution.service_id, human_action: action,
            required_fields: requiredFields,
            ...(requirementsRemaining ? { requirements_remaining: requirementsRemaining } : {}) },
          ...(reviewURL ? { handoff: { url: reviewURL, kind: "booking_review" } } : {}),
          instruction: reviewURL
            ? "已在 handoff.url 提供官方行程确认页，请用户在该页核对行程、席别与座位偏好并确认；页面打开请求不代表用户已确认。该页失效或用户更愿在对话中确认时，仍可按下述 input_template 一次合并提交。乘客姓名/证件等身份信息不在此提交，仍走受保护 Checkout 页。"
            : "向用户展示 context.review 中的行程（legs）与可选席别/座位偏好词表（seat_options），并明确告知：座位偏好仅为请求、不保证分配（对应 notice_version 文案须经用户同意）。这是购买前的合并确认：沿用用户已有的人数、实际席别和偏好，只询问 requirements_remaining 中尚缺的真实同意或选择；没有偏好时允许自动分配，不强迫选择字母。仅代码写法修正且购买条件与条款未变时沿用已有明确确认；行程、人数、金额或条款实质变化则核对变化并取得必要确认。然后按 required_fields 组装完整 JSON 对象，经 --input-json <file> 提交——draft_revision 必须等于服务端当前值，被拒绝（booking_review_changed）时重新读取后重试。未得真实确认不得提交，不能暗设 accept_non_guaranteed。乘客姓名/证件等身份信息不在此提交，仍走受保护 Checkout 页。",
          next: null,
          interaction: {
            schema_version: "itpay.interaction.v1",
            stage: "booking_review_required",
            input_template: {
              command: `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved --input-json <file> --json`,
              required_input: ["file", ...requiredFields],
              executable: false,
            },
          },
          recovery: [],
        };
      }
      return {
        status: "confirmation_required",
        result: { service_execution_id: id, service_id: execution.service_id, human_action: action },
        instruction: "请展示待确认的内容，请用户明确确认后，按 input_schema 填写 --input 字段。继续同一执行，不重新查询；这一步不是购买确认。",
        next: null,
        interaction: {
          schema_version: "itpay.interaction.v1",
          stage: "confirmation_required",
          input_template: {
            command: `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved${requiredFields.map((field) => ` --input ${field}=<值>`).join("")} --json`,
            required_input: requiredFields,
            executable: false,
          },
        },
        recovery: [],
      };
    }
    const recovery = state === "recovery_required" || state === "failed";
    let command = `itpay services next ${id} --json`;
    if (state === "payment") command = `itpay services checkout ${id} --json`;
    // input_required: the resume command needs a real file path — expose it as
    // a non-executable input_template, not a fake `next.command`.
    const inputTemplate = state === "input_required"
      ? {
          command: `itpay services run ${execution.service_id} --execution ${id} --input-json <file> --json`,
          required_input: ["file"],
          executable: false as const,
        }
      : undefined;
    const guidance = railServiceGuidance(execution.service_id, model.workflow_entry?.input_schema);
    const failedStep = recovery ? model.workflow?.failure?.step_id : undefined;
    const failedStepGuidance = failedStep ? WORKFLOW_STEP_GUIDANCE[failedStep] : undefined;
    const failedInvocation = recovery
      ? [...model.provider_invocations].reverse().find((item) => typeof item.status === "string" && item.status.startsWith("failed"))
      : undefined;
    const providerErrorCode = typeof failedInvocation?.error_code === "string" && failedInvocation.error_code ? failedInvocation.error_code : undefined;
    const quoteFailure = execution.service_id === "itpay-rail-booking" ? ({
      quote_source_unavailable: "实时车票数据暂不可用；保留原选择，稍后按用户意愿重新核验，不创建替代订单。",
      quote_train_changed: "所选车次的时刻或运行信息已变化；向用户说明并征询是否重新查票。",
      quote_seat_changed: "所选席别已变化；向用户说明并征询新的席别选择。",
      quote_seat_unavailable: "所选席别当前无足够余票；告知用户并由其决定是否换方案。",
      quote_refresh_expired: "实时报价过程超时；保留原选择，不把旧价当可付款价格。",
    } as Record<string, string>)[providerErrorCode ?? ""] : undefined;
    const failureCode = model.workflow?.failure?.reason_code ?? providerErrorCode ?? model.workflow?.error_code;
    const failedInstruction = recovery
      ? quoteFailure
        ? quoteFailure
        : failedStepGuidance
        ? `执行在「${failedStepGuidance.meaning}」步失败${failureCode ? `（错误码：${failureCode}）` : ""}：${failedStepGuidance.hint}。先核对原因和当前执行状态，不要盲目重放。`
        : state === "failed"
          ? `执行已失败${failureCode ? `（错误码：${failureCode}）` : ""}且不可续用；核对服务端原因、订单与付款事实后再决定下一步。`
          : "执行未完成，请按步骤错误处理；不要重建执行或重复调用。"
      : undefined;
    return {
      status: state,
      result: {
        service_execution_id: id,
        service_id: execution.service_id,
        workflow_state: state,
        ...(model.workflow ? { current_step: model.workflow.current_step, workflow_revision: model.workflow.revision } : {}),
        ...(model.workflow?.failure ? { failure: model.workflow.failure } : {}),
        ...(state === "input_required" ? { input_schema: model.workflow_entry.input_schema } : {}),
        ...(guidance && state === "input_required" ? { guidance } : {}),
        ...(failedStep ? { failed_step: failedStep, ...(failedStepGuidance ? { failed_step_meaning: failedStepGuidance.meaning } : {}) } : {}),
        ...(providerErrorCode ? { provider_error_code: providerErrorCode } : {}),
        ...(providerErrorCode && !quoteFailure ? { diagnostic_code: providerErrorCode } : {}),
        ...(recovery ? { retryable: false } : {}),
      },
      instruction: failedInstruction
        ?? (state === "payment"
          ? (model.workflow?.human_action?.context?.review
            ? "服务已到付款步骤，可直接 Checkout 付款；如需调整席别/座位偏好，先用 confirm_booking 动作修订（会重新报价并锁定新价），完成后再付款。"
            : "服务已到付款步骤，使用现有 Checkout 完成扫码付款。")
          : guidance
            ? "按 result.guidance 的字段契约填写输入后继续同一服务执行；不要臆造字段名。"
            : "继续读取同一执行；缺少输入时按服务声明补齐。"),
      next: recovery || inputTemplate ? null : { command, reason: "继续当前流程" },
      ...(inputTemplate || (state === "payment" && model.workflow?.human_action?.context?.review) ? {
        interaction: {
          schema_version: "itpay.interaction.v1" as const,
          stage: inputTemplate ? "input_required" : "payment",
          ...(inputTemplate ? { input_template: inputTemplate } : {}),
          ...(state === "payment" && model.workflow?.human_action?.context?.review ? {
            revise_template: {
              command: `itpay services action ${id} --action ${model.workflow.human_action.action_type} --actor-type human --status approved --input-json <file> --json`,
              required_input: ["file"],
              executable: false,
            },
          } : {}),
        },
      } : {}),
      recovery: recovery && state === "failed"
        ? [{ command: `itpay services get ${id} --json`, reason: "核对本执行的错误、结果和付款事实" }]
        : [],
    };
  }

	const terminalEnvelope = terminalExecutionEnvelope(model);
	if (terminalEnvelope) return terminalEnvelope;
	const currentItems = model.current_result_items ?? [];
  const latestInvocation = model.provider_invocations.at(-1);
  const latestPreview = latestInvocation?.safe_result_preview as Record<string, unknown> | undefined;
  if (currentItems.length === 0 && latestPreview?.search_status === "LOCATION_CONFIRMATION_REQUIRED" && latestPreview.location_confirmation) {
    const capability = model.capabilities.find((item) => item.capability_id === latestInvocation?.capability_id && item.phase === execution.phase && !item.requires_payment);
    if (capability) return locationConfirmationEnvelope(execution.service_execution_id, capability.capability_id,
      (latestInvocation?.request_summary ?? {}) as Record<string, unknown>, latestPreview.location_confirmation as Record<string, unknown>);
  }
	const delivery = currentDelivery;
	const deliveryMode = serviceDeliveryMode(model);
	if (execution.service_id === "itpay-rail-exact" && currentItems.length > 0) {
		const item = currentItems[0]!;
		const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
		const total = typeof container?.catalog_total === "number" ? container.catalog_total :
			Array.isArray(container?.candidates) ? container.candidates.length : 0;
		return {
			status: total > 0 ? "result_ready" : "no_result",
			result: { service_execution_id: execution.service_execution_id, scope: "station_pair",
				resolved_station_pair: container?.resolved_station_pair, total,
				result_item_id: item.service_capability_result_item_id,
                trains: Array.isArray(container?.candidates) ? container.candidates.slice(0, 3).map((value, index) => ({ ...compactExactTrain(value as Record<string, unknown>), detail: { command: `itpay services page ${execution.service_execution_id} ${item.service_capability_result_item_id} --offset ${index} --limit 1 --json`, reason: "读取该条席别和购买凭据" } })) : [],
				...(exactSmartTemplate(container?.resolved_station_pair, execution.service_execution_id, item.service_capability_result_item_id)
					? { smart_template: exactSmartTemplate(container?.resolved_station_pair, execution.service_execution_id, item.service_capability_result_item_id) } : {}) },
			instruction: total > 0
				? "直达站对结果已保存。执行 next.command 一次读取紧凑车次行，按用户条件筛选；若只需比较，答复后结束；已有购票委托则读取所选行详情。"
				: "这一已解析站对返回 0 条；不代表全城无车。若原需求需要更广覆盖，可核验另一可信站对或 Smart。",
			next: { command: `itpay services read-result ${execution.service_execution_id} --json`, reason: "读取这一保存站对的紧凑分页；按返回的续页覆盖所需范围" },
			recovery: [],
		};
	}
	const candidateSelection = model.allowed_actions?.find((action) => action.type === "select_candidate");
	if (candidateSelection && currentItems.length > 0) {
		const paidCapability = delivery?.capability_id
			? model.capabilities.find((capability) => capability.capability_id === delivery.capability_id && capability.requires_payment)
			: undefined;
		return {
			status: "candidate_selection_available",
			result: {
				service_execution_id: execution.service_execution_id,
				...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
				...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
				items: currentItems.map((item) => ({
					rank: item.rank,
					title: item.display_title,
					safe_payload: item.safe_payload,
				})),
			},
			instruction: paidCapability
				? "付费搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才执行 next.command；不要提及 safe_payload 或自动购买后续报告。"
				: "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时才提交对应编号；不要提及 safe_payload、Execution 或内部 ID。",
			next: {
				command: `itpay services action ${execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
				reason: paidCapability ? "仅在用户明确选择候选并要求继续时执行" : "仅在用户明确选择后锁定来源候选",
			},
			recovery: [],
		};
	}
  if (deliveryMode === "agent_visible_result") {
			const items = currentItems.map((item) => ({
      rank: item.rank,
      title: item.display_title,
      safe_payload: item.safe_payload,
    }));
		const selection = model.allowed_actions?.find((action) => action.type === "select_candidate");
		const railCatalog = currentItems.some((item) => {
			const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
			return container?.catalog_page !== undefined || container?.cost_semantics !== undefined;
		});
		const pageRecovery = currentItems.flatMap((item) => {
      const container = (item.safe_payload?.result ?? item.safe_payload) as Record<string, unknown> | undefined;
      const catalogPage = container?.catalog_page as { next_offset?: number } | undefined;
      const nextOffset = catalogPage?.next_offset;
      return typeof nextOffset === "number"
        ? [{ command: `itpay services page ${execution.service_execution_id} ${item.service_capability_result_item_id} --offset ${nextOffset} --json`, reason: "读取已保存结果的同版本下一页，不重新查询、不消耗额度" }]
        : [];
    });
		const railCostGuidance = "铁路应付只含票价加服务费（quoted_total_minor）；地面接驳是单独估算（estimated_ground_minor），两者相加是已知估算（estimated_door_to_door_minor），不是收款额。";
		const instruction = (delivery?.order_id
			? appendFeedbackPostmortemInstruction(items.length > 0
				? selection
					? "搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才执行 next.command；不要提及 safe_payload。"
					: "这一步的结果已经可用。用普通语言解释可公开字段并停止；不要提及 Arazzo、safe_payload 或内部 ID。"
				: "告诉用户本次查询得到 0 个结果并停止。Agent 不读取其他交付、不重放当前查询、修改输入或创建新查询。", "delivered")
			: items.length > 0
			? selection
				? "搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才执行 next.command；不要提及 safe_payload。"
				: "这一步的结果已经可用。用普通语言解释可公开字段并停止；不要提及 Arazzo、safe_payload 或内部 ID。"
			: "告诉用户本次查询得到 0 个结果并停止。Agent 不读取其他交付、不重放当前查询、修改输入或创建新查询。")
			+ (railCatalog && items.length > 0 ? ` ${railCostGuidance}` : "");
		return {
      status: items.length > 0 ? "result_ready" : "no_result",
			result: {
				service_execution_id: execution.service_execution_id,
				...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
				...(delivery?.order_id ? { order_id: delivery.order_id } : {}),
				delivery_mode: deliveryMode,
				items,
			},
			instruction,
			next: selection ? {
				command: `itpay services action ${execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
				reason: "仅在用户明确选择后锁定来源候选",
			} : null,
			recovery: pageRecovery,
    };
  }
  if (deliveryMode === "vault_artifact") {
    const grantStatus = normalizeGrantStatus(delivery?.grant_status);
    const grantActive = grantStatus === "active";
    const grantPending = grantStatus === "pending";
    return {
      status: grantActive ? "grant_active" : grantPending ? "result_preparing" : "human_authorization_required",
      result: {
        service_execution_id: execution.service_execution_id,
        ...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
        delivery_mode: deliveryMode,
        grant_status: grantStatus,
        ...(delivery?.preparation ? { preparation: delivery.preparation } : {}),
        ...(grantActive && delivery?.grant_expires_at ? { grant_expires_at: delivery.grant_expires_at } : {}),
      },
      instruction: grantActive
        ? "先告诉用户付费内容已经准备好且当前读取授权有效；立即读取并只解释授权字段，遵守范围与到期时间。"
        : grantPending
          ? "告诉用户：授权已经完成，付费结果仍在同一订单下准备，不需要再次付款或授权。然后只执行 next.command 查询同一笔服务；Agent 不创建新服务、付款页面或数据请求，也不提前读取。"
          : "先告诉用户付费内容已经归入当前订单，但需要本人确认一次读取授权；请用户在订单页面授权，未授权前不要读取或猜测内容。",
      next: grantPending ? {
        command: `itpay services next ${execution.service_execution_id} --json`,
        reason: "等待同一 Execution 的交付准备完成",
      } : {
        command: `itpay services read-result ${execution.service_execution_id} --json`,
        reason: grantActive ? "读取当前有效 grant 的结果" : "仅在用户确认授权后执行",
      },
      recovery: [],
    };
  }

	const allowedActions = model.allowed_actions ?? [];
	const preferred = allowedActions[0];
	if (preferred?.type === "prepare_quote") {
		const continuation = paidContinuation(model, preferred, {});
		if (continuation) {
			return {
				status: execution.status,
				result: {
					service_execution_id: execution.service_execution_id,
					service_id: execution.service_id,
					phase: execution.phase,
					checkout: continuation.checkout,
				},
				instruction: purchaseConfirmationInstruction(
					execution.status === "quota_exhausted" ? "quota_exhausted" : "candidate_selected",
					continuation.price,
					continuation.capability.delivery_email_required,
					continuation.capability.delivery_email_purpose,
				),
				next: continuation.next,
				recovery: [],
			};
		}
	}
	const next = preferred ? serviceAllowedActionCommand(model, preferred) : null;
	return {
    status: execution.status,
    result: {
      service_execution_id: execution.service_execution_id,
      service_id: execution.service_id,
      phase: execution.phase,
			allowed_actions: allowedActions.map((action) => ({
				type: action.type,
				...(action.capability_id ? { capability_id: action.capability_id } : {}),
				requires_human: action.requires_human,
			})),
		},
		instruction: preferred?.type === "resume_checkout"
			? "这笔服务已经有付款页面。只执行 next.command 恢复并展示同一个入口；Agent 不创建新的报价、购物车、付款页面或服务。"
			: preferred?.type === "wait"
				? "告诉用户付款和订单已经确认，结果仍在同一笔服务中处理，不需要再次付款；如果最终无法交付，将从原订单检查退款路径。稍后只执行 next.command；Agent 不创建新服务、付款页面或数据请求，也不承诺退款结果。"
				: preferred?.requires_human
			? "当前下一步需要用户明确选择；先展示必要信息并等待确认。"
				: preferred ? "执行服务端返回的唯一首选动作；不要猜测其他 capability。" + locationInputInstruction(model.capabilities.find((item) => item.capability_id === preferred.capability_id)?.input_schema) : "当前没有后续动作。",
		next,
		recovery: [{ command: `itpay services get ${execution.service_execution_id} --json`, reason: "仅在当前动作异常时检查时间线" }],
	};
}

function serviceAllowedActionCommand(model: ServiceExecutionReadModel, action: ServiceExecutionAllowedAction): CommandAction | null {
	const executionID = model.execution.service_execution_id;
	const capability = action.capability_id
		? model.capabilities.find((item) => item.capability_id === action.capability_id)
		: undefined;
	switch (action.type) {
	case "invoke_capability": {
		if (!capability) return null;
		const input = Object.fromEntries(requiredInputFields(capability.input_schema).map((field) => [field, "<value>"]));
		return {
			command: `itpay services invoke ${executionID} --capability ${capability.capability_id}${formatInputOptions(input)} --json`,
			reason: "执行当前允许的 Agent-visible capability",
		};
	}
	case "select_candidate":
		return {
			command: `itpay services action ${executionID} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
			reason: "仅在用户明确选择后提交当前候选 rank",
		};
	case "prepare_quote": {
		return paidContinuation(model, action, {})?.next ?? null;
	}
	case "resume_checkout":
		return { command: `itpay services checkout ${executionID} --resume --json`, reason: "恢复同一 Checkout，不创建第二笔" };
	case "wait":
		return { command: `itpay services next ${executionID} --json`, reason: "等待 durable execution 推进" };
	case "view_delivery":
		return { command: `itpay services next ${executionID} --json`, reason: "读取当前交付模式" };
	default:
		return null;
	}
}

function serviceDeliveryMode(model: ServiceExecutionReadModel): string {
	const delivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  const entry = model.capabilities.find(capability => capability.capability_id === model.workflow_entry?.capability_id);
  if (!delivery && model.workflow?.status === "completed" && entry?.requires_payment === false && !entry.vault_required) return "agent_visible_result";
  const explicit = String(delivery?.redacted_summary?.delivery_mode ?? "");
  if (explicit) return explicit;
  return delivery?.vault_artifact_id ? "vault_artifact" : "";
}

function normalizeGrantStatus(status: string | undefined): string {
  return !status || status === "missing" ? "none" : status;
}

function grantedResultEnvelope(response: GrantedServiceResult, orderID?: string): CommandEnvelope {
  return {
    status: "granted_result_ready",
    result: {
      service_execution_id: response.service_execution_id,
      ...(orderID ? { order_id: orderID } : {}),
      ...(response.expires_at ? { grant_expires_at: response.expires_at } : {}),
      granted_fields: Object.keys(response.result),
      payload: response.result,
    },
    instruction: orderID
      ? appendFeedbackPostmortemInstruction("结果来自当前有效 Vault Grant；只使用本次授权字段，过期后停止读取并重新请求用户同意。", "delivered")
      : "结果来自当前有效 Vault Grant；只使用本次授权字段，过期后停止读取并重新请求用户同意。",
    next: null,
    recovery: [],
  };
}

function servicesNextPlainResult(result: Record<string, unknown>): string[] {
  return plainValueLines(result);
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
    instruction: "这是已保存的诊断事件；事件不代表车票结果，也不授权重放业务步骤。已读完所需诊断时停止；实际任务沿先前返回的当前动作继续。",
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

export function parseKeyValueList(values: string[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const value of values ?? []) {
    const index = value.indexOf("=");
    if (index <= 0) {
      throw new Error(`invalid --input "${value}", expected key=value`);
    }
    result[value.slice(0, index)] = parseValue(value.slice(index + 1));
  }
  return result;
}

export function collectOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function parseValue(value: string): unknown {
  // Structured inputs (objects/arrays) are passed as JSON; a string that merely
  // starts with a JSON delimiter but is not valid JSON stays a string — the
  // backend schema validates the field type either way.
  if (value.startsWith("{") || value.startsWith("[")) {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}


function buildServicesCheckoutEnvelope(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  checkoutURL: string,
  plan: ReturnType<typeof buildCheckoutQRPlan>,
  agentType?: string,
  target?: string,
): CommandEnvelope {
  const checkout = response.checkout;
  const platform = platformKeyForHost(plan.host);
	const amount = formatMoney(checkout.checkout.amount_minor, checkout.checkout.currency);
  const presentationHandoff = buildCheckoutHandoff({
    platform,
    url: plan.linkOnlyURL ?? checkoutURL,
    mobileUrl: checkoutURL,
    amount,
    plan,
    ...(agentType ? { agentType } : {}),
    ...(target ? { target } : {}),
    ...(plan.preferredQRSources[0] ? { qrImageURL: plan.preferredQRSources[0] } : {}),
    ...(plan.ideImageAttach?.status === "downloaded" && plan.ideImageAttach.localPath
      ? { localPath: plan.ideImageAttach.localPath }
      : {}),
    ...(platform === "markdown" ? { markdown: buildAgentChatHandoff(plan).markdown } : {}),
  });
  return {
    status: "human_checkout_required",
    result: {
      service_execution_id: response.binding.service_execution_id,
      checkout_id: checkout.checkout.checkout_id,
      capability_id: checkoutCapabilityID(response),
      items: plan.orderItems ?? [],
      amount,
      ...(checkout.checkout.expires_at ? {
        // The shared server-owned payable deadline D: refreshing the page or
        // re-creating a checkout can never extend it; past it the checkout
        // and pending order are terminally cancelled.
        payment_deadline_at: checkout.checkout.expires_at,
      } : {}),
    },
    handoff: presentationHandoff.handoff,
    instruction: presentationHandoff.instruction,
    next: {
      command: plan.afterActionCommand ?? `itpay checkout --id ${checkout.checkout.checkout_id} --token ${checkout.display_token} --json`,
      reason: "仅在用户完成付款操作或要求查询后，读取同一 Checkout 的权威状态",
    },
    recovery: [],
  };
}

function fallbackCardURL(baseURL: string, checkoutID: string, displayToken: string): string {
  const root = baseURL.replace(/\/$/, "");
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/card?display_token=${encodeURIComponent(displayToken)}`;
}

function fallbackCardPNGURL(baseURL: string, checkoutID: string, displayToken: string): string {
  return `${fallbackCardURL(baseURL, checkoutID, displayToken)}.png`.replace("/card?", "/card.png?");
}

function checkoutCapabilityID(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  fallback = "",
): string {
  return response.capability_id || fallback;
}

function absolutePublicURL(baseURL: string, value: string): string {
	try {
		return new URL(value, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();
	} catch {
		return value;
	}
}

function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function normalizeServiceActionStatus(status: string, serviceExecutionID: string): string {
  const normalized = status.trim().toLowerCase();
  if (!serviceActionStatuses.has(normalized)) {
    throw actionInputError(
      serviceExecutionID,
      `invalid --status "${status}". Supported: pending, approved, rejected, expired, cancelled`,
    );
  }
  return normalized;
}

function tokenizedCheckoutURL(checkoutURL: string, displayToken: string, qrPayload: string): string {
  if (qrPayload.trim().length > 0) {
    return qrPayload;
  }
  if (checkoutURL.trim().length === 0 || displayToken.trim().length === 0) {
    return checkoutURL;
  }
  try {
    const parsed = new URL(checkoutURL);
    if (!parsed.searchParams.has("display_token")) {
      parsed.searchParams.set("display_token", displayToken);
    }
    return parsed.toString();
  } catch {
    const separator = checkoutURL.includes("?") ? "&" : "?";
    return `${checkoutURL}${separator}display_token=${encodeURIComponent(displayToken)}`;
  }
}


export interface ServicesRunOptions extends ServicesCommandOptions {
  executionID?: string;
  jsonOutput?: boolean;
  host?: ClientHost;
  target?: string;
  timeoutSeconds?: number;
  pollIntervalMS?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runServicesRun(
  backend: BackendClient,
  config: CLIConfig,
  serviceID: string,
  input: Record<string, unknown> | undefined,
  options: ServicesRunOptions = {},
): Promise<void> {
  let id = options.executionID;
  try {
    if (!id) {
      const started = await backend.startServiceExecution({
        service_id: serviceID,
        client_context: { host: options.host ?? "terminal", features: [...RAIL_PROGRESSIVE_FEATURES], ...(options.target ? { target: options.target } : {}) },
        ...(input !== undefined ? { input } : {}),
      });
      id = started.execution.service_execution_id;
      if (!started.workflow_entry) {
        await runServicesNext(backend, id, options);
        return;
      }
    }
    let model = await backend.getServiceExecution(id);
    if (model.execution.service_id !== serviceID) throw new Error("execution belongs to another service");
    if (!model.workflow_entry || (input === undefined && !model.workflow)) {
      await runServicesNext(backend, id, options);
      return;
    }
    if (input !== undefined) {
      model = await backend.advanceServiceExecution(id, input, `workflow-input:${id}`);
    } else if (model.workflow?.status === "quota_paused") {
      model = await backend.advanceServiceExecution(id, undefined, `workflow-resume:${id}`);
    }
    const until = Date.now() + (options.timeoutSeconds ?? 120) * 1000;
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const paid = () => model.payment_bindings.some((binding) => binding.status === "payment_verified") || model.checkout_bindings.some((binding) => binding.status === "payment_verified");
    // A planning projection can exist before any usable result or user action.
    // Keep the existing bounded wait until there is something to hand over.
    while ((["queued", "running", "delivery"].includes(model.workflow?.status ?? "") || (model.workflow?.status === "payment" && paid())) && shouldWaitForServiceResult(model) && Date.now() < until) {
      await sleep(options.pollIntervalMS ?? 1500);
      model = await backend.getServiceExecution(id);
    }
    if (model.refunds.some(refund => refund.access_locked)) {
      await runServicesNext(backend, id, options);
      return;
    }
    if (model.workflow?.status === "payment" && !paid()) {
      await runServicesCheckout(backend, config, id, model.workflow_entry?.capability_id, {
        ...options,
        ...(config.agentType ? { agentType: config.agentType } : {}),
        resume: model.checkout_bindings.length > 0,
      });
      return;
    }
    await runServicesNext(backend, id, options);
  } catch (cause) {
    if (cause instanceof HttpError && cause.code === "rail_seat_code_invalid" && id) {
      throw new CommandContractError(
        cause.code,
        cause.message,
        "席别必须使用原查询 booking_template.seat_choices 中与名称对应的代码，不能填“二等座”等显示名。用原 selection token 与真实人数修正输入，继续同一booking execution；若只是代码写法修正且车次、席别名称、人数等购买条件未变，沿用用户已给的确认，不再重复询问。",
        [{ command: `itpay services next ${id} --json`, reason: "读取同一booking当前状态后修正输入" }],
      );
    }
    if (cause instanceof CommandContractError || cause instanceof HttpError || cause instanceof DeviceLockBusyError || cause instanceof DeviceStateError) throw cause;
    if (!id) {
      throw new CommandContractError(
        "workflow_start_outcome_unknown",
        cause instanceof Error ? cause.message : "service creation outcome unknown",
        "创建服务执行时没有收到完整响应。先查询当前身份可见的执行；不要直接重跑并创建替代执行。",
        [{ command: "itpay services list --json", reason: "查找可能已经创建的服务执行" }],
      );
    }
    if (cause instanceof HttpTransportError) throw new CommandContractError("workflow_outcome_unknown", cause.message, "未收到完整响应；只读同一执行的权威事实，不重放写操作或创建替代执行。", [{ command: `itpay services next ${id} --json`, reason: "核对同一执行" }]);
    throw new CommandContractError(
      "workflow_run_failed",
      cause instanceof Error ? cause.message : "workflow run failed",
      "保留当前执行并按错误处理，不要重复创建服务执行。",
      [{ command: `itpay services next ${id} --json`, reason: "读取同一执行的当前事实与恢复动作" }],
    );
  }
}
