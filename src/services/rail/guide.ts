import { serviceInputTemplate } from "../shared/input.js";


// Declared at execution creation: the client understands the rail.progressive.v2
// response format (rail_planning projection, snapshot paging, rsel_ handles).
// The server alone decides service version, quota and provider credentials.
export const RAIL_PROGRESSIVE_FEATURES = ["rail.progressive.v2"] as const;

// Teaching-oriented guidance for ItPay's own rail services. The published
// workflow input schema may be permissive, so the CLI teaches the real
// contract here instead of letting agents guess field names.
export interface RailFieldSpec { name: string; required?: boolean; description: string; example?: string; enum?: string }

export interface RailServiceGuidance {
  when_to_use: string;
  input_fields: RailFieldSpec[];
  optional_fields?: RailFieldSpec[];
  input_example: Record<string, unknown>;
  notes?: string[];
}

export const RAIL_ENDPOINT_BRIEF = "首次查询按已读rail-booking完成路线判断；原地点、约束和摘要未变就沿用，不重复读指南。";

export const RAIL_SERVICE_GUIDANCE: Record<string, RailServiceGuidance> = {
  "itpay-rail-exact": {
    when_to_use: "用于可信固定站对的直达核验；只覆盖本次站对。路线判断遵循已读rail-booking。",
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
    when_to_use: "用于已明确的中转、多站或具体地点比较；保留两端各自类别和约束。路线判断遵循已读rail-booking。",
    input_fields: [
      { name: "origin", required: true, description: "出发地：已知最完整的位置名或区域（城市/区县/地址均可）", example: "<原始完整地点>" },
      { name: "destination", required: true, description: "目的地：保留用户原始完整地点或范围", example: "<用户原始完整目的地>" },
      { name: "travel_date", required: true, description: "出行日期 YYYY-MM-DD；字段名必须是 travel_date", example: "<用户日期 YYYY-MM-DD>" },
    ],
    optional_fields: [
      { name: "origin_city", description: "出发地城市提示，辅助位置解析" },
      { name: "destination_city", description: "目的地城市提示" },
      { name: "origin_location", description: "已知坐标对象（高德 GCJ-02）" },
      { name: "destination_location", description: "目的地坐标对象" },
      { name: "depart_after", description: "不早于该时间出发" },
      { name: "depart_before", description: "不晚于该时间出发；保留用户明确上限" },
      { name: "arrive_after", description: "不早于该时间到达；与最晚到达一起作为资格条件，不只作排序" },
      { name: "depart_before", description: "不晚于该时间出发" },
      { name: "arrive_before", description: "不晚于该时间到达" },
      { name: "user_query", description: "旅行需求原话，最多4096 UTF-8字节；时间等明确条件仍填写对应结构化字段" },
      { name: "seat_preferences", description: "已确认的席别代码数组，不填写旅客身份" },
      { name: "priority", enum: "balanced|fastest|cheapest|safest|flexible", description: "方案偏好" },
      { name: "duration_basis", enum: "rail|door_to_door", description: "最快默认按铁路全程含换乘；明确要求且接驳证据完整时可按门到门" },
      { name: "max_transfers", description: "允许中转次数，0-2" },
      { name: "passengers", description: "成人乘客整数 1-5；不填写身份资料" },
    ],
    input_example: { origin: "<用户原始完整出发地>", destination: "<用户原始完整目的地>", travel_date: "<用户出行日期 YYYY-MM-DD>" },
    notes: [
      "位置有歧义时会进入位置确认步骤，请用户选定后继续同一执行",
      "推荐结果含每趟车的席别与余票；购票在后续受保护流程完成",
    ],
  },
};

export function railServiceGuidance(serviceID: string, schema?: Record<string, unknown>): RailServiceGuidance | undefined {
  const guidance = RAIL_SERVICE_GUIDANCE[serviceID];
  if (serviceID !== "itpay-rail-smart" || !guidance) return guidance;
  const properties = schema?.properties as Record<string, unknown> | undefined;
  if (!properties?.endpoints) return properties?.origin && properties?.destination ? guidance : undefined;
  return {
    ...guidance,
    input_fields: [
      { name: "endpoints", required: true, description: "origin/destination 各填完整text；类别有依据时填kind(area/place/station)。仅对象含义明确、类别确实待核验时可省略kind；完整名称合法，坐标可选，不靠省略kind猜城市" },
      { name: "travel_date", required: true, description: "用户出行日期 YYYY-MM-DD" },
    ],
    optional_fields: (guidance.optional_fields ?? []).filter((field) => !["origin_city", "destination_city", "origin_location", "destination_location"].includes(field.name)).concat([
      { name: "reuse_from", description: "同 owner 的已保存 Exact result_item_id 或 Smart snapshot_id；端点/日期新查询可复用有效事实" },
    ]).filter(field => properties[field.name] !== undefined),
    input_example: { endpoints: { origin: { kind: "place", text: "<用户原始完整具体地点>" }, destination: { kind: "area", text: "<用户原始完整行政范围>" } }, travel_date: "<用户出行日期 YYYY-MM-DD>" },
    notes: ["只使用返回模板的端点字段，不混用其他输入外壳", "唯一地点直接解析；真实候选只确认有歧义一端；地图等待按可续用状态恢复，终态有新证据才用返回新查询模板，无动作则停止"],
  };
}

export const WORKFLOW_STEP_GUIDANCE: Record<string, { meaning: string; hint: string }> = {
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

export function locationInputInstruction(schema: Record<string, unknown> | undefined): string {
 const properties=schema?.properties as Record<string,unknown>|undefined;
 if(properties?.endpoints)return " 当前模板的endpoints.origin/destination保留完整text；kind只按可靠依据填写，未知不猜。坐标可选且必须真实；复制完整file_content，仅补错误字段，其余用户条件不变。";
 if(properties?.origin_location && properties?.destination_location)return " 保留原始完整地点和范围；已有真实坐标才填写，其他可选项只按当前schema。复制完整file_content，不猜坐标或业务条件。";
 return "";
}

// Compatibility normalization belongs only to the declared rail adapter.
export function railInputTemplate(schema: Record<string, unknown>, known: Record<string, unknown> = {}): Record<string, unknown> {
 const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
 if (properties?.endpoints && !properties.origin && !properties.destination && !known.endpoints && (typeof known.origin === "string" || typeof known.destination === "string")) known={...known,endpoints:{origin:{text:known.origin},destination:{text:known.destination}}};
 if (properties?.travel_date && !known.travel_date && typeof known.date === "string") known={...known,travel_date:known.date};
 const result=serviceInputTemplate(schema,known);
 // Current Smart exposes endpoints through oneOf rather than top-level required.
 // Preserve a supplied legacy branch; otherwise use the complete declared pair.
 if (properties?.endpoints && !known.origin && !known.destination && !result.endpoints) result.endpoints=serviceInputTemplate(properties.endpoints);

 if (properties?.accept_non_guaranteed) result.accept_non_guaranteed=false;
 return result;
}

export function railOverviewInstruction(topic:string):string {
 return `尚未创建执行或查询。按完整模板选择当前操作；已读指南沿用，仅首次铁路查询按${topic}完成路线判断。查询结果不是价格同意。`;
}
