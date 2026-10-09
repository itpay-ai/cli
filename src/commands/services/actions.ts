import { serviceAdapter } from "../../services/registry.js";
import { type BackendClient } from "../../client/backend.js";
import { type RecordServiceExecutionActionRequest } from "../../client/types.js";
import { CommandContractError, writeCommandEnvelope } from "../../services/shared/envelope.js";
import { ServicesCommandOptions, normalizeServiceActionStatus, paidContinuation, serviceAllowedActionCommand, purchaseConfirmationInstruction, actionInputError } from "../../services/shared/platform.js";
import { servicesNextEnvelope } from "../../services/presentation.js";

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
        // A failed write is never replayed. Only the locked execution identifies its adapter.
        try { const model = await backend.getServiceExecution(serviceExecutionID); serviceAdapter(model.execution).actionError(error,serviceExecutionID,actionType); }
        catch (recoveryError) { if (recoveryError instanceof CommandContractError) throw recoveryError; }
		throw error;
	}
  if (actionType === "approve_purchase" && "status" in response && response.status === "approved") {
    const quoteID = typeof input.service_quote_lock_id === "string" ? input.service_quote_lock_id : "";
    writeCommandEnvelope({
      status: "purchase_preparation_approved",
      result: {service_execution_id: serviceExecutionID, evidence_source: "agent_reported", scope: "prepare_checkout", service_quote_lock_id: quoteID},
      instruction: "已记录同范围的准备付款入口批准；这是Agent报告的真实会话同意，不是已付款或出票。继续使用本报价；条件未变不重复询问，官方页实际支付仍由用户完成。",
      next: quoteID ? {command: `itpay cart add --quote ${quoteID} --json`, reason: "加入本次已批准报价，准备同一个付款入口"} : null,
      recovery: [{command: `itpay services next ${serviceExecutionID} --json`, reason: "读取原执行与付款状态，不重新购买"}],
    }, { ...(options.jsonOutput !== undefined ? {jsonOutput: options.jsonOutput} : {}), ...(options.output ? {output:options.output} : {}) });
    return;
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

export async function resolveCandidateSelection(
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
