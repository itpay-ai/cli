import { operationInputTemplate } from "../shared/input.js";
import { serviceAdapterKey } from "../registry.js";
import { HttpError } from "../../client/http.js";
import { CommandContractError, fileInputTemplate } from "../shared/envelope.js";


export const RAIL_LOCATION_EVIDENCE_REASONS = new Set(["endpoint_kind_conflict", "place_identity_uncertain", "endpoint_adcode_name_conflict", "endpoint_poi_name_conflict", "endpoint_station_name_code_conflict", "location_evidence_required", "coordinate_name_mismatch", "area_scope_too_broad", "address_required", "administrative_area_unresolved", "station_location_evidence_required", "coordinate_identity_unverified"]);

export const RAIL_QUOTE_FAILURE_GUIDANCE: Record<string, string> = {
      quote_source_unavailable: "实时车票数据暂不可用；保留原选择，稍后按用户意愿重新核验，不创建替代订单。",
      quote_train_changed: "所选车次的时刻或运行信息已变化；向用户说明并征询是否重新查票。",
      quote_seat_changed: "所选席别已变化；向用户说明并征询新的席别选择。",
      quote_seat_unavailable: "所选席别当前无足够余票；告知用户并由其决定是否换方案。",
      quote_refresh_expired: "实时报价过程超时；保留原选择，不把旧价当可付款价格。",
    };

export function railRunError(cause: unknown,serviceID: string,id?: string): void {
    if (cause instanceof HttpError && ["invalid_selection", "selection_wrong_buyer"].includes(cause.code ?? "")) {
      const reason = cause.payload?.reason;
      const inputInvalid = reason === "input_constraint_invalid";
      throw new CommandContractError(cause.code, cause.message,
        inputInvalid ? "输入违反当前完整计划约束。读取原查询的完整购买模板，修正人数、完整段数和顺序；不要追加未声明字段或拆单。"
          : cause.code === "selection_wrong_buyer" ? "当前身份无权使用这份购买凭据。停止；不要切换身份绕过，也不展示其他买家资料。"
          : reason === "stored_selection_inconsistent" ? "服务端凭据与已存目录不一致，补参数无法修复。停止购买并提供诊断标识 stored_selection_inconsistent；不猜字段、不重新创建购买。"
          : "购买凭据未通过校验，原因尚未确定且没有安全自动恢复。停止，不把推测报成原因或追加隐藏字段。",
        inputInvalid ? [{command:id ? `itpay services get ${id} --json` : "itpay services list --json",reason:"只读原执行或可见原查询，取得当前完整模板；不创建执行"}] : [],
        undefined,{service_id:serviceID, ...(id?{service_execution_id:id}:{}), ...(reason?{reason}:{}), execution_created:cause.payload?.execution_created ?? "unknown"});
    }
    if (cause instanceof HttpError && cause.code === "rail_selection_expired") {
      const expiry = cause.payload?.selection_expiry;
      const bookingID = expiry?.booking_execution_id ?? id;
      const refreshInput = !bookingID && expiry?.safe_new_query && ["itpay-rail-smart", "itpay-rail-exact"].includes(expiry.query_service_id) ? expiry.query_input : undefined;
      const sourceBinding = expiry?.query_public_binding;
      const sourceSupported = !!expiry && serviceAdapterKey({service_id:expiry.query_service_id, service_contract_version_id:"", ...(sourceBinding ? {public_binding:sourceBinding} : {})}) === "rail.v1";
      // Legacy errors retain their declared internal operation; public errors
      // require the verified source binding to preserve the public query.
      const refresh = refreshInput !== undefined && (!cause.payload?.public_binding || sourceSupported);
      const originalInput = refreshInput ? {...refreshInput} : undefined;
      if (originalInput) delete originalInput.reuse_from;
      throw new CommandContractError(cause.code, cause.message,
        refresh ? "刚才余票信息已过时，按原条件刷新一次真实库存（可能消耗查询额度）；不需要重复批准同条件查票。刷新后按完整路线、车次、席别及价格核对原选择，不按新排名盲选；有价格、库存或条款变化再确认。仅刷新一次，失败即报告原因；不复用旧库存、不换站或日期。"
          : bookingID ? "保留原购买执行，先读取订单与付款事实；不要重新查票、创建替代购买或重复付款。"
          : `旧选择凭据已过期，历史详情不会刷新库存或续期；${expiry?.recovery_block_reason ?? "缺少完整原查询条件、受支持的源合同或安全购买状态证据"}，停止自动刷新。`,
        bookingID ? [{command: `itpay services next ${bookingID} --json`, reason: "核对原购买执行和付款状态"}] : [],
        refresh && originalInput && expiry ? {schema_version: "itpay.interaction.v1", stage: "input_required", input_template:
          operationInputTemplate({serviceID:sourceBinding?.public_service_id ?? expiry.query_service_id, ...(sourceBinding ? {operationID:sourceBinding.operation_id} : {})}, originalInput),
        } : undefined,
        {service_id: serviceID, ...(bookingID ? {service_execution_id: bookingID} : {}), execution_created: cause.payload?.execution_created ?? "unknown", ...(expiry ? {selection_expiry: expiry} : {})});
    }
    if (cause instanceof HttpError && cause.code === "rail_journey_selection_required") {
      throw new CommandContractError(cause.code!, cause.message,
        "整程必须使用原查询当前完整ticket plan模板；不手拼票段或拆单。缺少模板时只读原方案，无法取得就停止，不擅自换站或日期。",
        [{command:id ? `itpay services get ${id} --json` : "itpay services list --json",reason:"只读原执行或可见原查询，取得当前完整方案模板"}],undefined,{service_id:serviceID,...(id?{service_execution_id:id}:{})});
    }
    if (cause instanceof HttpError && cause.code === "rail_seat_code_invalid" && id) {
      throw new CommandContractError(
        cause.code,
        cause.message,
        "席别必须使用原查询 booking_template.seat_choices 中与名称对应的代码，不能填“二等座”等显示名。用原 selection token 与真实人数修正输入，继续同一booking execution；若只是代码写法修正且车次、席别名称、人数等购买条件未变，沿用用户已给的确认，不再重复询问。",
        [{ command: `itpay services next ${id} --json`, reason: "读取同一booking当前状态后修正输入" }],
      );
    }
}

export function railActionError(error:unknown,serviceExecutionID:string,actionType:string):void {
		if (error instanceof HttpError && ["booking_review_invalid", "booking_review_changed", "booking_review_locked"].includes(error.code)) {
			throw new CommandContractError(
				error.code,
				error.message,
				error.code === "booking_review_invalid"
					? "确认输入与当前草稿不符。使用返回 interaction.input_template.input 当前review模板，席别使用返回的代码，不填显示名或猜新值。若仅修正代码写法，且车次、实际席别、人数、价格及条款等已确认内容未变，可沿用用户已有明确确认后提交；草稿实质变化或缺少真实同意时，先请用户确认变化内容。"
					: error.code === "booking_review_changed"
						? "草稿版本已变化；使用同一booking的当前review模板。仅技术修正且车次、实际席别、人数、价格及条款未变时沿用已有明确同意；实质变化或缺少真实同意才补确认。"
						: "当前购买已有付款尝试；读取同一booking及订单状态，不创建新订单或重做付款。",
				error.payload?.review ? [] : [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "读取同一booking的当前状态与review" }],
                error.payload?.review?.input_template ? {
                  schema_version: "itpay.interaction.v1", stage: "consent_required",
                  consent_rule: "先核对聊天明确确认或等价已存同意是否覆盖当前范围、人数、价格及条款；未变且已覆盖则转述已有同意，不重复问。缺少真实同意或实质变化才展示缺失或变化部分并等待。模板false不代表需要新增回答；技术修正不产生同意，Agent提交是转述。",
                  input_template: fileInputTemplate(`itpay services action ${serviceExecutionID} --action ${actionType} --actor-type agent --status approved --input-json <file> --json`, error.payload.review.input_template as Record<string, unknown>, [], {executionID:serviceExecutionID}),
                } : undefined,
                {service_execution_id: serviceExecutionID, review: error.payload?.review, input_errors: error.payload?.input_errors},
			);
		}
}

export const railInputRecoveryInstruction = "Agent按当前模板自行修正错误字段和JSON层级，保留已有摘要的端点含义及原地点/日期/人数，不重复研究或事后补写冒充查询前摘要；不要向用户询问技术字段。只有真实业务歧义才问人；使用返回的执行身份恢复，未创建时用原服务。";
