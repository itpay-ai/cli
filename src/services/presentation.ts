import { serviceAdapter } from "./registry.js";
import { type ServiceExecutionReadModel } from "../client/types.js";
import { refundStateEnvelope } from "./shared/refund.js";
import { appendFeedbackPostmortemInstruction, type CommandEnvelope, isTerminalServiceExecutionStatus } from "./shared/envelope.js";
import { terminalExecutionEnvelope, serviceDeliveryMode, normalizeGrantStatus, paidContinuation, purchaseConfirmationInstruction, serviceAllowedActionCommand } from "./shared/platform.js";

export function servicesNextEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const execution = model.execution;
  const adapter = serviceAdapter(execution);
  const currentDelivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  const lockedRefund = model.refunds.find((refund) => refund.access_locked);
  if (lockedRefund) {
    const refundState = refundStateEnvelope(lockedRefund, "delivery_locked");
    return { ...refundState, result: { ...refundState.result, service_execution_id: execution.service_execution_id, refund: {refund_request_id: lockedRefund.refund_request_id, status: lockedRefund.status, ...(lockedRefund.failure_class ? {failure_class: lockedRefund.failure_class} : {})} },
      next: refundState.next ? {command: `itpay refund get ${lockedRefund.refund_request_id} --json`, reason: "读取同一退款权威状态"} : null };
  }
  const unsettledPayment = model.payment_bindings.some(binding=>typeof binding.status === "string" && ["pending","outcome_unknown","unknown","processing"].includes(binding.status));
  if(unsettledPayment) return {status:"payment_outcome_pending",result:{service_execution_id:execution.service_execution_id,payment_state:"unsettled",checkout_ids:model.checkout_bindings.map(binding=>binding.checkout_id)},instruction:"原付款结果尚未确认。保留同一执行、Checkout和订单，只核对权威事实；不创建新报价、购物车、付款入口或购买，也不宣称已付款或服务已完成。",next:null,recovery:[{command:`itpay services get ${execution.service_execution_id} --json`,reason:"仅用户要求或平台恢复后核对同一付款事实"}]};
  // Terminal facts take priority unless the locked adapter supports same-execution recovery.
  if (!(adapter.preservesTerminalRecovery(model)) && isTerminalServiceExecutionStatus(execution.status) && !["completed", "delivery_completed"].includes(execution.status)) {
    // Preserve the registered adapter's safe failure facts even at execution terminal.
    const failedWorkflow = execution.status === "failed" && model.workflow?.status === "failed" ? adapter.workflow(model) : undefined;
    if (failedWorkflow) return {...failedWorkflow,next:null};
    const terminal = terminalExecutionEnvelope(model);
    if (terminal) return terminal;
  }
  const businessState = adapter.projectState(model);
  if (businessState) return businessState;
  const availableResult = adapter.savedResult(model);
  if (availableResult && adapter.shouldWait(model) === false) return availableResult;
  const latestRun = model.execution_requests?.filter((request) => request.execution_kind === "service.execution.run").at(-1);
  if (latestRun && ["pending", "started"].includes(latestRun.status) && model.workflow?.status !== "failed") {
    return {
      status: "running",
      result: { service_execution_id: execution.service_execution_id, execution_request_id: latestRun.execution_request_id },
      instruction: "任务仍在排队或执行中，稍后读取同一任务。不要重新查询、重复提交输入或把等待状态当作零结果。",
      next: { command: `itpay services next ${execution.service_execution_id} --timeout 60 --json`, reason: "有界等待同一任务，累计最多120秒；收集宿主同一命令最终输出", poll_after_ms:1500 },
      recovery: [],
    };
  }
  if (latestRun && ["failed", "cancelled"].includes(latestRun.status) && !model.workflow_entry) {
    return {
      status: latestRun.status,
      result: { service_execution_id: execution.service_execution_id },
      instruction: "本次任务未完成，需要检查同一任务的处理记录；这不表示没有结果。不要自动重新发起。",
      next: null,
      recovery: [{ command: `itpay services events ${execution.service_execution_id} --json`, reason: "读取同一任务的处理记录" }],
    };
  }
  if (!adapter.supported) return {status:"presentation_contract_unavailable",result:{service_execution_id:execution.service_execution_id,service_id:execution.service_id,service_contract_version_id:execution.service_contract_version_id,public_binding:execution.public_binding},instruction:"当前锁定呈现合同不受本候选支持；保留执行与已有结果并停止，取得兼容CLI后读取同一执行，不猜模式或启动新购买。",next:null,recovery:[]};
  const workflowEnvelope = adapter.workflow(model);
  if (workflowEnvelope) return workflowEnvelope;

	const terminalEnvelope = terminalExecutionEnvelope(model);
	if (terminalEnvelope) return terminalEnvelope;
	const currentItems = model.current_result_items ?? [];
  const savedRailResult = adapter.savedResult(model);
  if (savedRailResult) return savedRailResult;
  const delivery = currentDelivery;
  const deliveryMode = serviceDeliveryMode(model);
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
				? "付费搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才提交 interaction 中的对应编号；不要提及 safe_payload 或自动购买后续服务。"
				: "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时才提交对应编号；不要提及 safe_payload、Execution 或内部 ID。",
            next: null,
            interaction: candidateInteraction(execution.service_execution_id),
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
    const deliveryGuidance = adapter.deliveryGuidance(model);
		const instruction = (delivery?.order_id
			? appendFeedbackPostmortemInstruction(items.length > 0
				? selection
					? "搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才提交 interaction 中的对应编号；不要提及 safe_payload。"
					: "这一步的结果已经可用。用普通语言解释可公开字段并停止；不要提及 Arazzo、safe_payload 或内部 ID。"
				: "告诉用户本次查询得到 0 个结果并停止。Agent 不读取其他交付、不重放当前查询、修改输入或创建新查询。", "delivered")
			: items.length > 0
			? selection
				? "搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才提交 interaction 中的对应编号；不要提及 safe_payload。"
				: "这一步的结果已经可用。用普通语言解释可公开字段并停止；不要提及 Arazzo、safe_payload 或内部 ID。"
			: "告诉用户本次查询得到 0 个结果并停止。Agent 不读取其他交付、不重放当前查询、修改输入或创建新查询。")
			+ (deliveryGuidance?.instruction && items.length > 0 ? ` ${deliveryGuidance.instruction}` : "");
		return {
      status: items.length > 0 ? "result_ready" : "no_result",
			result: {
				service_execution_id: execution.service_execution_id,
				...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
				...(delivery?.order_id ? { order_id: delivery.order_id, aftercare:{optional:true,command:`itpay feedback submit --order ${delivery.order_id} --json`,reason:"结果答复后按需复盘；不猜评分"} } : {}),
				delivery_mode: deliveryMode,
				items,
			},
			instruction,
            next: null,
            ...(selection ? {interaction: candidateInteraction(execution.service_execution_id)} : {}),
			recovery: deliveryGuidance?.recovery ?? [],
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
				: preferred ? "执行服务端返回的唯一首选动作；不要猜测其他 capability。" + adapter.locationInstruction(model.capabilities.find((item) => item.capability_id === preferred.capability_id)?.input_schema) : "当前没有后续动作。",
		next,
		recovery: [{ command: `itpay services get ${execution.service_execution_id} --json`, reason: "仅在当前动作异常时检查时间线" }],
	};
}

function candidateInteraction(id: string): NonNullable<CommandEnvelope["interaction"]> {
 return {schema_version:"itpay.interaction.v1", stage:"candidate_selection_required", input_template:{command:`itpay services action ${id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,required_input:["rank"],executable:false}};
}
