import { executionInputContext, operationInputTemplate } from "../shared/input.js";
import { type ServiceExecutionReadModel } from "../../client/types.js";
import { type CommandEnvelope } from "../shared/envelope.js";
import { requiredInputFields } from "../shared/platform.js";
import { locationConfirmationEnvelope } from "./query.js";
import { RAIL_LOCATION_EVIDENCE_REASONS, RAIL_QUOTE_FAILURE_GUIDANCE } from "./recovery.js";
import { railServiceGuidance, WORKFLOW_STEP_GUIDANCE, RAIL_ENDPOINT_BRIEF } from "./guide.js";
import { railInputTemplate as serviceInputTemplate } from "./guide.js";

export function railWorkflowEnvelope(model: ServiceExecutionReadModel): CommandEnvelope | undefined {
 const execution = model.execution;
  if (model.workflow_entry && !["completed", "delivery"].includes(model.workflow?.status ?? "")) {
    const id = execution.service_execution_id;
    const workflowReason = model.workflow?.failure?.reason_code ?? model.workflow?.error_code;
    const paymentVerified = model.payment_bindings.some((binding) => binding.status === "payment_verified") || model.checkout_bindings.some((binding) => binding.status === "payment_verified");
    const state = model.workflow?.status === "payment" && paymentVerified ? "running" : model.workflow?.status ?? "input_required";
    if (["quota_paused", "failed"].includes(state) && !RAIL_LOCATION_EVIDENCE_REASONS.has(workflowReason ?? "") && (model.workflow?.dependency ||
      /^amap_/.test(workflowReason ?? ""))) {
      const dependency = model.workflow?.dependency;
      const resumable = state === "quota_paused" && dependency?.retryable === true;
      return {
        status: "dependency_unavailable",
        result: { service_execution_id: id, service_id: execution.service_id, reason: workflowReason, failure: model.workflow?.failure, affected_endpoint: model.workflow?.failure?.endpoint ?? dependency?.endpoint, ...(dependency ? {dependency} : {}) },
        instruction: resumable
          ? "地图服务暂时限流。保留原条件及已解析端点；到 retry_at 后执行下一步，继续同一任务，不重新提交地点。"
          : "地图服务本轮未完成解析，这是外部依赖故障，不要求用户换地址或自行找坐标。有界尝试已结束；保留原条件及已有结果，交由服务维护方处理该错误。",
        next: resumable ? {command: `itpay services run ${execution.service_id} --execution ${id} --json`, reason: "等待所示恢复时间后继续同一执行"} : null,
        recovery: [],
      };
    }
    if (state === "failed" && RAIL_LOCATION_EVIDENCE_REASONS.has(workflowReason ?? "")) {
      const code = workflowReason!;
      const affected = model.workflow?.failure?.endpoint ?? model.workflow?.dependency?.endpoint;
      const query = model.workflow?.query_input ?? {};
      const endpoints = query.endpoints && typeof query.endpoints === "object" ? query.endpoints as Record<string, Record<string, unknown>> : {};
      const stationPair = [endpoints.origin, endpoints.destination].every(endpoint => endpoint?.kind === "station" && typeof endpoint.text === "string" && endpoint.text.trim() && typeof endpoint.station_code === "string" && /^[A-Z]{3}$/.test(endpoint.station_code));
      if (code === "station_location_evidence_required") {
        const exactInput = stationPair && typeof query.travel_date === "string" ? {origin:endpoints.origin!.text, destination:endpoints.destination!.text, travel_date:query.travel_date} : undefined;
        return {status: "system_evidence_required", result:{service_execution_id:id,service_id:execution.service_id,reason:code,affected_endpoint:affected,failure:model.workflow?.failure,query,
          ...(exactInput ? {new_query_template:{command:"itpay services run itpay-rail-exact --input-json <双锁站直达.json> --json",input:exactInput,executable:false,required_input:["file"],instruction:"当前明确双锁站可核验直达；Exact只覆盖这一站对，仍按原人数、时限和偏好核对结果。"}} : {})},
          instruction:"尚未查票。车站身份已知，但Smart缺车站坐标证据；这是系统证据缺口，不要求用户填技术坐标或换站。"+(exactInput ? "当前双锁站可按完整模板另用Exact核验直达，原需求见query。" : "本路线Smart暂受系统证据限制，当前无可执行恢复；停止并交由维护方补证据。"),next:null,recovery:[]};
      }
      if (affected !== "origin" && affected !== "destination") return {status:"input_evidence_required",result:{service_execution_id:id,reason:code,failed_step:model.workflow?.failure?.step_id,failure:model.workflow?.failure,query},instruction:"地点问题未明确受影响侧，当前无可提交修正模板；保留原需求，停止并核对服务端事实，不猜另一端或坐标。",next:null,recovery:[]};
      const properties = model.workflow_entry.input_schema.properties as Record<string, unknown> | undefined;
      if (!properties?.endpoints && properties?.[affected] === undefined) return {status:"contract_unavailable",result:{service_execution_id:id,reason:code,failed_step:model.workflow?.failure?.step_id,failure:model.workflow?.failure,query},instruction:"旧查询已终止，当前锁定合同缺少可用地点字段；保留原需求并停止，不猜新旧模板或隐藏字段。",next:null,recovery:[]};
      const input = {...Object.fromEntries(Object.entries(query).filter(([key]) => properties?.[key] !== undefined)), ...serviceInputTemplate(model.workflow_entry.input_schema,query)};
      const identityConflict = ["endpoint_kind_conflict", "endpoint_adcode_name_conflict", "endpoint_poi_name_conflict", "endpoint_station_name_code_conflict", "coordinate_name_mismatch"].includes(code);
      const replacement = code === "area_scope_too_broad" ? {kind:"area",text:"<受影响端的市县镇完整名称>"} : {...(endpoints[affected]?.kind ? {kind:endpoints[affected].kind} : {}),text:code === "coordinate_identity_unverified" ? "<已核实与地点身份一致的完整地址或地点名>" : "<已补充行政归属的完整地址或地点名>"};
      const endpointContract = properties?.endpoints !== undefined && (query.endpoints !== undefined || !properties.origin || !properties.destination);
      if (endpointContract) input.endpoints = {...endpoints,[affected]:replacement};
      else {
        input[affected] = replacement.text;
        delete input[`${affected}_location`];
      }
      const originalPlace = endpoints[affected]?.text ?? query[affected];
      return {status:"awaiting_input",result:{service_execution_id:id,service_id:execution.service_id,reason:code,failed_step:model.workflow?.failure?.step_id,classification:"location_evidence_required",affected_endpoint:affected,original_place:originalPlace,...(model.workflow?.failure?.resolved_scope ? {resolved_scope:model.workflow.failure.resolved_scope} : {}),failure:model.workflow?.failure,query,
        new_query_template:{command:`itpay services run ${execution.service_id} --input-json <补全原始需求.json> --json`,input,executable:false,required_input:["file",endpointContract ? `endpoints.${affected}.text` : affected],...(endpointContract ? {correction_fields:["text", "kind", "poi_id", "location"].filter(field => {const side = ((properties?.endpoints as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>)?.[affected];return !!(side?.properties as Record<string, unknown>)?.[field];})} : {}),instruction:"旧执行输入已锁定；补真实地点后将完整input写入JSON文件，按此命令提交新查询，保留另一端、日期、人数和所有原约束。"}},
        instruction:`旧执行已终止，尚未查票。${identityConflict ? "名称、类别或位置证据存在冲突；先核实返回原因，不能修改kind绕过。" : "完整地点名称合法，但尚缺唯一身份证据；可先用地图或浏览短查，不要求必填门牌或坐标。"}新证据确定类别且原意未变可纠正kind；改变目的地或扩大范围须先取得真实同意。保留原地点及范围；${affected === "origin" ? "出发端" : "到达端"}原文见original_place。有新证据后只补充${affected === "origin" ? "出发端" : "到达端"}${code === "area_scope_too_broad" ? "的市县镇范围" : code === "coordinate_identity_unverified" ? "的已核实地点身份；已移除未核实坐标，不猜坐标" : "的完整地点和行政归属"}。使用当前完整new_query_template；不能在旧执行伪造修改，也不能直接提交占位符。`,next:null,recovery:[]};
    }
    if (state === "failed" && ["login_required", "rate_limited"].includes(workflowReason ?? "")) {
      const login = workflowReason === "login_required";
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
    if ((state === "human_action" || (state === "failed" && model.workflow?.human_action?.context?.quote_recovery === true)) && model.workflow?.human_action) {
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
              ? { resolved_place: { name: name(place), address: place.formatted_address, location: place.location } }
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
            required_fields: requiredFields, sides, query: model.workflow?.query_input,
            ...(sides.some(side => side.status !== "resolved" && !side.candidates?.length && ["ADDRESS_REQUIRED", "ADMINISTRATIVE_AREA_UNRESOLVED"].includes(side.reason ?? "")) ? {
              new_query_template: {command: `itpay services run ${execution.service_id} --input-json <补全原始需求.json> --json`, executable: false,
                input: serviceInputTemplate(model.workflow_entry.input_schema, model.workflow?.query_input ?? {}),
                required_input: ["补缺失端点", "保留原始日期人数时限偏好及已确认端点"], instruction: "原执行锁定输入；补全原需求后用新查询，不提交不存在的候选。"},
            } : {}) },
          instruction: sides.some(side => side.status !== "resolved" && !side.candidates?.length)
            ? locationConfirmationEnvelope(id, "", {}, {endpoints: sides.filter(side => side.status !== "resolved")}).instruction
            : requiredFields.includes("choices")
            ? "尚未查票。仅向用户展示有真实歧义端点的候选编号、名称、行政地址与类型（内部 id 仅用于回填，不展示给人）；用户选定后，把各未解析端点的候选 id 放入 choices 对象，继续同一执行。已解析端点无需再选；不得替用户决定，也不是购买确认。"
            : "向用户展示有歧义一端的候选；按 required_fields 填写真实选择，已解析一端保留原值。继续同一执行；这不是购买确认。",
          next: null,
          ...(sides.some(side => side.status !== "resolved" && !side.candidates?.length) ? {} : { interaction: {
            schema_version: "itpay.interaction.v1",
            stage: "location_confirmation_required",
            input_template: {
              command: requiredFields.includes("choices")
                ? `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved --input-json <地点确认.json> --json`
                : `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved${requiredFields.map((field) => ` --input ${field}=<值>`).join("")} --json`,
              input: { choices: Object.fromEntries(sides.filter(side => side.candidates?.length).map(side => [side.side, "<所选候选id>"])) },
              required_input: requiredFields,
              executable: false,
            },
          } }),
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
          status: state === "failed" ? "quote_recovery_required" : "booking_review_required",
          result: { service_execution_id: id, service_id: execution.service_id, review, ...(state === "failed" ? {failure:model.workflow?.failure} : {}),
            action_type: action.action_type, required_fields: requiredFields,
            ...(requirementsRemaining ? { requirements_remaining: requirementsRemaining } : {}) },
          ...(reviewURL ? { handoff: { url: reviewURL, kind: "booking_review" } } : {}),
          instruction: `${state === "failed" ? `${typeof model.workflow?.failure?.affected_leg === "number" ? `第${model.workflow.failure.affected_leg+1}段` : ""}报价失败：${RAIL_QUOTE_FAILURE_GUIDANCE[model.workflow?.failure?.reason_code ?? ""] ?? "报价核验未完成。"} 当前无完整报价、无付款入口。按用户意愿有界地重新核验一次同一购买；复制下方当前确认模板，未变条款沿用真实同意，价格/车次/席别/人数/条款变化须确认差异。无票或车次变化时先让用户决定，不能自动换路线。支付尝试后不得修订。 ` : ""}${reviewURL ? "官方确认页见 handoff.url，打开不等于确认；沿用已知人数和席别。" : "当前草稿见 review。"} 对照对话只补缺失选择或真实条款同意；无字母偏好自动分配，不默认问字母。仅代码修正且车次、实际席别、人数、价格及条款不变，沿用已有明确确认；实质变化只核对变化。复制 interaction.input_template.input；自动分配使用该对象数组，不传 null 或字符串。只有用户本人已接受当前条款，才把 accept_non_guaranteed 改为 true；选车或委托选票不等于条款同意，false是未同意保护而非模板错误。缺同意时仅用 review.consent_question 问一次；没有该文案时说明座位/卧铺偏好可能自动分配，并按当前notice补整程条款。已有充分同意且条件不变则不再问。身份信息只在官方 Checkout 页填写。`,
          next: null,
          interaction: {
            schema_version: "itpay.interaction.v1",
            stage: "booking_review_required",
            input_template: {
              command: `itpay services action ${id} --action ${action.action_type} --actor-type human --status approved --input-json <file> --json`,
              required_input: ["file", ...requiredFields],
              input: review.input_template && typeof review.input_template === "object"
                ? review.input_template as Record<string, unknown> : serviceInputTemplate(action.input_schema ?? {}, review),
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
    const guidance = railServiceGuidance(execution.service_id, model.workflow_entry?.input_schema);
    const inputTemplate = state === "input_required"
      ? operationInputTemplate(executionInputContext(execution), serviceInputTemplate(model.workflow_entry?.input_schema ?? {}, Object.keys(model.workflow?.query_input ?? {}).length ? (model.workflow?.query_input ?? {}) : guidance?.input_example ?? {}), requiredInputFields(model.workflow_entry?.input_schema))
      : undefined;
    if (state === "input_required" && execution.service_id === "itpay-rail-smart" && !guidance) {
      return {status:"contract_unavailable",result:{service_execution_id:id,service_id:execution.service_id},instruction:"当前锁定合同缺失；读取一次同执行合同后仍缺失就停止，不猜新旧输入结构。",next:{command:`itpay services get ${id} --json`,reason:"获取锁定合同一次"},recovery:[]};
    }
    const failedStep = recovery ? model.workflow?.failure?.step_id : undefined;
    const failedStepGuidance = failedStep ? WORKFLOW_STEP_GUIDANCE[failedStep] : undefined;
    const failedInvocation = recovery
      ? [...model.provider_invocations].reverse().find((item) => typeof item.status === "string" && item.status.startsWith("failed"))
      : undefined;
    const providerErrorCode = typeof failedInvocation?.error_code === "string" && failedInvocation.error_code ? failedInvocation.error_code : undefined;
    const quoteFailure = execution.service_id === "itpay-rail-booking" ? RAIL_QUOTE_FAILURE_GUIDANCE[(model.workflow?.failure?.reason_code === "workflow_failed" ? providerErrorCode : model.workflow?.failure?.reason_code) ?? providerErrorCode ?? ""] : undefined;
    const failureCode = model.workflow?.failure?.reason_code === "workflow_failed" && providerErrorCode && RAIL_QUOTE_FAILURE_GUIDANCE[providerErrorCode] ? providerErrorCode : model.workflow?.failure?.reason_code ?? providerErrorCode ?? model.workflow?.error_code;
    const failedInstruction = recovery
      ? quoteFailure
        ? `${typeof model.workflow?.failure?.affected_leg === "number" ? `第${model.workflow.failure.affected_leg + 1}段报价失败。` : ""}${quoteFailure} 当前整程未取得完整有效报价，没有付款入口；保留同一购买和未变化的选择，当前没有可提交恢复动作，停止；需要用户决定或系统处理，不能靠反复 get/next 重新报价，不能收取其余段款项或重复创建购买。`
        : failedStepGuidance
        ? `执行在「${failedStepGuidance.meaning}」步失败${failureCode ? `（错误码：${failureCode}）` : ""}：${failedStepGuidance.hint}。先核对原因和当前执行状态，不要盲目重放。`
        : state === "failed"
          ? `执行已失败${failureCode ? `（错误码：${failureCode}）` : ""}且不可续用；${execution.service_id === "itpay-rail-booking" || paymentVerified ? "核对服务端原因、订单与付款事实" : "保留原地点和约束，核对服务端原因；当前没有可执行恢复则停止，不重复读取终态"}后再决定下一步。`
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
          : state === "input_required" && guidance
            ? RAIL_ENDPOINT_BRIEF + "按 result.guidance 的字段契约填写输入后继续同一服务执行；不要臆造字段名。"
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
      recovery: recovery && state === "failed" && !["itpay-rail-exact", "itpay-rail-smart"].includes(execution.service_id)
        ? [{ command: `itpay services get ${id} --json`, reason: "核对本执行的错误、结果和付款事实" }]
        : [],
    };
  }

return undefined;
}
