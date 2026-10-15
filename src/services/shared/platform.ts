import { type BackendClient } from "../../client/backend.js";
import { type GrantedServiceResult, type ServiceCapability, type ServiceExecutionReadModel, type ServiceExecutionAllowedAction } from "../../client/types.js";
import { serviceInputTemplate } from "./input.js";
import { taskJournalPath } from "../../state/config.js";
import { TaskJournal } from "../../state/task_journal.js";
import { type OutputSink } from "../../render/sink.js";
import { buildCheckoutHandoff } from "../../render/checkout_handoff.js";
import { buildAgentChatHandoff } from "../../render/markdown.js";
import { platformKeyForHost } from "../../render/plan.js";
import { buildCheckoutQRPlan } from "../../render/checkout_plan.js";
import { appendFeedbackPostmortemInstruction, CommandContractError, type CommandAction, type CommandEnvelope, isTerminalServiceExecutionStatus, shellArgument, plainValueLines, fileInputTemplate } from "./envelope.js";

export interface ServicesCommandOptions {
  deadline?: number;
  output?: OutputSink;
  env?: NodeJS.ProcessEnv;
}

// AUTH04: record the pause point of each Service Execution so a later
// `itpay auth login` can resume the SAME task. Ids/stage/resume command only —
// no chat content, PII or credentials. Best-effort: journaling never breaks
// a command.
export function journalTaskState(serviceExecutionID: string, envelope: CommandEnvelope, env: NodeJS.ProcessEnv): void {
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

export function remainingAutomaticWait(id:string,env:NodeJS.ProcessEnv):number {
 try{return new TaskJournal(taskJournalPath(env)).remainingAutomaticWait(id);}catch{return 0;}
}
export function recordAutomaticWait(id:string,milliseconds:number,env:NodeJS.ProcessEnv):number {
 try{return new TaskJournal(taskJournalPath(env)).recordAutomaticWait(id,milliseconds);}catch{return 0;}
}

export const serviceActionStatuses = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);

export function requiredInputFields(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

export function serviceResultPlainLines(result: Record<string, unknown>): string[] {
  return plainValueLines(result);
}

export function queryText(input: Record<string, unknown>): string {
  const value = Object.values(input).find((item) => typeof item === "string" && item.trim() !== "");
  return typeof value === "string" ? value : JSON.stringify(input);
}

export function missingRequiredInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): string[] {
  return requiredInputFields(schema).filter((field) => {
    if (!(field in input) || input[field] === null || input[field] === undefined) return true;
    return typeof input[field] === "string" && String(input[field]).trim() === "";
  });
}

export function checkoutCommand(
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

export function capabilityPrice(capability: ServiceCapability): string {
	if (capability.pricing_method !== undefined) return "动态报价（最终金额以锁定报价为准）";
	return capability.price_amount_minor !== undefined && capability.price_currency
		? formatMoney(capability.price_amount_minor, capability.price_currency)
		: "当前发布价格";
}

export function purchaseConfirmationInstruction(
	context: "quota_exhausted" | "candidate_selected",
	price: string,
	deliveryEmailRequired: boolean,
	deliveryEmailPurpose?: ServiceCapability["delivery_email_purpose"],
	candidateTitle = "",
): string {
	const emailPurpose = deliveryEmailPurposeText(deliveryEmailPurpose);
	if (context === "quota_exhausted") {
		return deliveryEmailRequired
			? `免费额度已用完，本次没有发送到数据来源，也没有创建付款页面。只向用户说明：继续当前请求需要支付 ${price}，并提供${emailPurpose}；请确认是否购买并提供邮箱。然后停止等待。用户明确同意并提供真实邮箱前，Agent 不提交购买输入，也不创建或尝试其他购买路径。`
			: `免费额度已用完，本次没有发送到数据来源，也没有创建付款页面。只向用户说明：“继续当前请求需要支付 ${price}，是否购买？”然后停止等待。用户明确同意前，Agent 不提交购买输入，也不创建或尝试其他购买路径。`;
	}
	const selected = candidateTitle ? `已选择 ${candidateTitle}。` : "当前候选已经确认。";
	return deliveryEmailRequired
		? `${selected}后续服务尚未购买。只向用户说明：继续购买需要支付 ${price}，并提供${emailPurpose}；请确认是否购买并提供邮箱。然后停止。用户明确同意并提供真实邮箱前，Agent 不提交购买输入，也不创建新的服务或付款页面。`
		: `${selected}后续服务尚未购买。只向用户说明：“继续购买后续服务需要支付 ${price}，是否购买？”然后停止。用户明确同意前，Agent 不提交购买输入，也不创建新的服务或付款页面。`;
}

export function deliveryEmailPurposeText(purpose?: ServiceCapability["delivery_email_purpose"]): string {
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

export function paidContinuation(
	model: ServiceExecutionReadModel,
	action: ServiceExecutionAllowedAction,
	input: Record<string, unknown>,
): {
	capability: ServiceCapability;
	price: string;
	checkout: Record<string, unknown>;
	next: CommandAction | null;
 input_template?: ReturnType<typeof fileInputTemplate>;
} | null {
	if (!action.capability_id) return null;
	const capability = model.capabilities.find((item) => item.capability_id === action.capability_id && item.requires_payment);
	if (!capability) return null;
	const price = capabilityPrice(capability);
	const stateBacked = model.execution.status === "quota_exhausted" || model.execution.status === "human_action_approved";
    const missing=stateBacked?[]:missingRequiredInput(capability.input_schema,input);
    const template=missing.length || capability.delivery_email_required ? fileInputTemplate(`itpay services checkout ${model.execution.service_execution_id} --capability ${capability.capability_id} --input-json <file>${capability.delivery_email_required?" --email <email>":""} --json`,stateBacked?input:serviceInputTemplate(capability.input_schema ?? {},input),[...missing,...(capability.delivery_email_required?["email"]:[])],{executionID:model.execution.service_execution_id}):undefined;
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
        ...(template?{input_template:template}:{}),
		next: template ? null : {
			command: checkoutCommand(model.execution.service_execution_id, capability, input, !stateBacked),
			reason: `仅在用户明确同意支付 ${price}${capability.delivery_email_required ? " 并提供真实邮箱" : ""}后执行；否则停止`,
		},
	};
}

export function quoteCommand(
  serviceExecutionID: string,
  capability: ServiceCapability,
  input: Record<string, unknown>,
): string {
	const lockedInput = { ...input };
	for (const field of missingRequiredInput(capability.input_schema, lockedInput)) lockedInput[field] = "<value>";
	return `itpay services quote ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)}${capability.delivery_email_required ? " --email <email>" : ""} --json`;
}

export function stableInput(input: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
}

export function formatInputOptions(input: Record<string, unknown>): string {
  return Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => String(value) === "<value>"
      ? ` --input ${key}=<value>`
      : ` --input ${shellArgument(`${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)}`)
    .join("");
}

export function actionInputError(serviceExecutionID: string, message: string, code = "service_action_invalid"): CommandContractError {
  return new CommandContractError(
    code,
    message,
    code === "candidate_not_found"
			? "当前 rank 不存在或当前候选集不可用。不要新建 Execution，不要重新 invoke，不要构造候选 ID；只恢复同一 Execution 当前仍然有效的候选。"
			: "使用当前 safe result 中的合法 action 和 candidate rank；需要人确认时先询问用户。",
    [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "重新读取同一 Execution 的当前可选动作" }],
  );
}

export function terminalExecutionEnvelope(model: ServiceExecutionReadModel): CommandEnvelope | null {
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
      ...(currentDelivery?.order_id ? { order_id: currentDelivery.order_id, aftercare: { optional: true, command: `itpay feedback submit --order ${shellArgument(currentDelivery.order_id)} --json`, reason: "告知原单结果后按需复盘，不猜评分或上传隐私" } } : {}),
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

export function serviceAllowedActionCommand(model: ServiceExecutionReadModel, action: ServiceExecutionAllowedAction): CommandAction | null {
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

export function serviceDeliveryMode(model: ServiceExecutionReadModel): string {
	const delivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  const entry = model.capabilities.find(capability => capability.capability_id === model.workflow_entry?.capability_id);
  if (!delivery && model.workflow?.status === "completed" && entry?.requires_payment === false && !entry.vault_required) return "agent_visible_result";
  const explicit = String(delivery?.redacted_summary?.delivery_mode ?? "");
  if (explicit) return explicit;
  return delivery?.vault_artifact_id ? "vault_artifact" : "";
}

export function normalizeGrantStatus(status: string | undefined): string {
  return !status || status === "missing" ? "none" : status;
}

export function grantedResultEnvelope(response: GrantedServiceResult, orderID?: string): CommandEnvelope {
  return {
    status: "granted_result_ready",
    result: {
      service_execution_id: response.service_execution_id,
      ...(orderID ? { order_id: orderID, aftercare:{optional:true,command:`itpay feedback submit --order ${shellArgument(orderID)} --json`,reason:"交付答复后按需复盘，不猜评分或上传隐私"} } : {}),
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

export function servicesNextPlainResult(result: Record<string, unknown>): string[] {
  return plainValueLines(result);
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

export function parseValue(value: string): unknown {
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

export function buildServicesCheckoutEnvelope(
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

export function fallbackCardURL(baseURL: string, checkoutID: string, displayToken: string): string {
  const root = baseURL.replace(/\/$/, "");
  return `${root}/v1/checkouts/${encodeURIComponent(checkoutID)}/card?display_token=${encodeURIComponent(displayToken)}`;
}

export function fallbackCardPNGURL(baseURL: string, checkoutID: string, displayToken: string): string {
  return `${fallbackCardURL(baseURL, checkoutID, displayToken)}.png`.replace("/card?", "/card.png?");
}

export function checkoutCapabilityID(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  fallback = "",
): string {
  return response.capability_id || fallback;
}

export function absolutePublicURL(baseURL: string, value: string): string {
	try {
		return new URL(value, baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();
	} catch {
		return value;
	}
}

export function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

export function normalizeServiceActionStatus(status: string, serviceExecutionID: string): string {
  const normalized = status.trim().toLowerCase();
  if (!serviceActionStatuses.has(normalized)) {
    throw actionInputError(
      serviceExecutionID,
      `invalid --status "${status}". Supported: pending, approved, rejected, expired, cancelled`,
    );
  }
  return normalized;
}

export function tokenizedCheckoutURL(checkoutURL: string, displayToken: string, qrPayload: string): string {
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

export function publicPurchaseTemplate(value:unknown):Record<string,unknown>|undefined {
 if (value === undefined) return undefined;
 const invalid=()=>new CommandContractError("public_operation_contract_invalid","incomplete public purchase operation","服务返回的准备购买合同不完整；保留当前快照与已有购买并停止，不能退回旧入口拼接凭据。",[],undefined,{reason:"purchase_contract_missing"});
 if(typeof value!=="object"||value===null||Array.isArray(value)||!("service_id" in value)||typeof value.service_id!=="string"||!("operation_id" in value)||typeof value.operation_id!=="string"||!("input" in value)||typeof value.input!=="object"||value.input===null||Array.isArray(value.input)||!("continuation" in value)) throw invalid();
 const ref=value.continuation;
 if(typeof ref!=="object"||ref===null||Array.isArray(ref)||!("service_execution_id" in ref)||typeof ref.service_execution_id!=="string"||!("snapshot_id" in ref)||typeof ref.snapshot_id!=="string")throw invalid();
 const template = fileInputTemplate(`itpay services run ${shellArgument(value.service_id)} --operation ${shellArgument(value.operation_id)} --input-json <file> --json`, {input:value.input,continuation:{service_execution_id:ref.service_execution_id,snapshot_id:ref.snapshot_id}});
 return {...template, input_example:template.file_content};
}
