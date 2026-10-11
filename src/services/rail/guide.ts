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

export const RAIL_ENDPOINT_BRIEF = "查询前先留下2–4行端点理解摘要：两端各指哪里、是车站/行政范围/具体地点、依据及未确定事实，再说明日期/人数/时限与Exact/Smart选择。对话或现有route-brief.txt二选一；已有摘要沿用，只更新变化项。含义不清先澄清，定位待核验不等于含义不清；勿凭字尾猜类型。";

export const RAIL_SERVICE_GUIDANCE: Record<string, RailServiceGuidance> = {
  "itpay-rail-exact": {
    when_to_use: "已知可信站对时先用本服务核验直达；城市需求可先形成有依据的站对假设。只覆盖这一站对，不代表全城市最优。只有明确可靠路线知识可直接用；大概率判断先短查，受阻且清晰双站可Exact核验。查询前记录两端含义、类别、依据、未知事实和Exact/Smart选择；格式见已读rail-booking。",
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
    when_to_use: "需要广泛站点比较、中转或具体地址接驳时使用；有可信站对且只需先核验直达可用 Exact。只有明确可靠路线知识可直接用；大概率判断先短查，受阻且清晰双站可Exact核验。查询前记录两端含义、类别、依据、未知事实和Exact/Smart选择；格式见已读rail-booking。",
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
    notes: ["仅用当前 input_schema 支持的端点写法；不要与旧 origin/destination 混用", "唯一地点直接解析；真实候选只确认有歧义一端；地图等待按可续用状态恢复，终态有新证据才用返回新查询模板，无动作则停止"],
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
  const properties = schema?.properties as Record<string, unknown> | undefined;
  if (properties?.endpoints) return " " + RAIL_ENDPOINT_BRIEF + " 两端分别填写 endpoints.origin/destination 的完整text；有类别依据就填kind，只有对象含义明确而类别待核验时可省略。区域保留范围、精确车站仅在目录验证后锁定。不要混用旧 origin/destination、手填锁站或伪造坐标。唯一地点会自动解析；只有真实多候选才让用户选返回的候选 id，地图失败应按当前执行恢复。";
  if (!properties?.origin_location || !properties?.destination_location) return "";
  if (!properties.location_confirmation) return " " + RAIL_ENDPOINT_BRIEF + " 地点保留用户已知最完整名称或城市范围；不要编造坐标或把城市改成同名车站。坐标及其他可选字段严格按当前 input_schema 提交。";
  return " " + RAIL_ENDPOINT_BRIEF + " 地点输入：保留两个地点或城市范围。已有可信高德 GCJ-02 坐标时，可用 --input 'origin_location={\"lng\":113.0,\"lat\":23.0,\"coordinate_system\":\"gcj02\",\"source\":\"amap\"}'（数值必须替换为真实查询结果，destination_location 同理）；没有地图能力时，直接传用户已知最完整的 origin/destination，可附 origin_city/destination_city。不要编造坐标、补猜地址或把深圳等城市改成深圳站；精确站查须明确站名。用户只给城市、县或镇就保留区域意图，不追问门牌。明确地点由服务自动解析；只有返回 location_confirmation 才展示候选名称、地址和高德链接，等待用户选择，禁止自行选第一项。";
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
 return `尚未创建执行或查询。先读 ${topic} 服务指南、理解用户完整地点与约束，形成简短路线摘要后选择操作；查询结果不是价格同意。`;
}
