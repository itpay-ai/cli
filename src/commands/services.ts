import type { BackendClient } from "../client/backend.js";
import type {
  GrantedServiceResult,
  RecordServiceExecutionActionRequest,
  ServiceCapability,
  ServiceCapabilityInvoked,
  ServiceExecutionReadModel,
  ServiceExecutionAllowedAction,
} from "../client/types.js";
import { operationID, type CLIConfig } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import type { OutputSink } from "../render/sink.js";
import { dispatchRender, type DispatchOptions } from "../render/index.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { platformKeyForHost } from "../render/plan.js";
import { renderTerminalQR } from "../render/qr.js";
import { buildCheckoutQRPlan } from "./buy.js";
import {
  CommandContractError,
  type CommandAction,
  type CommandEnvelope,
  isTerminalServiceExecutionStatus,
  writeCommandEnvelope,
} from "./guidance.js";

export interface ServicesCommandOptions {
  output?: OutputSink;
}

const serviceActionStatuses = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);

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
      ...(options.target ? { target: options.target } : {}),
      ...(options.clientContext ?? {}),
    },
  });
  const capability = response.capabilities.find((item) =>
    item.phase === response.execution.phase && !item.requires_payment,
  );
  const requiredInput = requiredInputFields(capability?.input_schema);
  const command = capability
    ? `itpay services invoke ${response.execution.service_execution_id} --capability ${capability.capability_id}${requiredInput.map((field) => ` --input ${field}=<value>`).join("")} --json`
    : `itpay services next ${response.execution.service_execution_id} --json`;
  const capabilitySummary = capability ? {
    capability_id: capability.capability_id,
    required_input: requiredInput,
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
      ? "填写首选 capability 的 required_input；一次只提交当前 execution 所代表的服务意图。"
      : "当前没有可直接调用的 capability；读取服务端下一步，不要猜测 capability。",
    next: {
      command,
      reason: capability ? "执行当前允许的能力" : "读取服务端计算的下一步",
    },
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

function requiredInputFields(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
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
		const command = quoteCommand(serviceExecutionID, requestedCapability, input);
    throw new CommandContractError(
      "checkout_required",
      `capability ${capabilityID} requires checkout and cannot be invoked directly`,
			"该 capability 需要付款；先向用户确认购买，再创建报价。",
			[{ command, reason: "锁定可信输入和价格" }],
    );
  }
  const missingInput = missingRequiredInput(requestedCapability.input_schema, input);
  if (missingInput.length > 0) {
    const correctedInput = { ...input };
    for (const field of missingInput) correctedInput[field] = "<value>";
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "补齐 required_input 后重试同一个 execution；本次没有调用 Provider。",
      [{
        command: `itpay services invoke ${serviceExecutionID} --capability ${capabilityID}${formatInputOptions(correctedInput)} --json`,
        reason: "提交完整 capability 输入",
      }],
    );
  }
  const idempotencyKey = await operationID(config, `service.invoke:${serviceExecutionID}:${capabilityID}:${stableInput(input)}`);
  const response = await backend.invokeServiceCapability(serviceExecutionID, capabilityID, {
    idempotency_key: idempotencyKey,
    redacted_summary: input,
  });
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
    items,
    ...(quota ? { quota } : {}),
  };
  let status = items.length > 0 ? "result_ready" : "no_result";
  let instruction = items.length > 0
		? "向用户展示编号和 safe_payload；若候选列表已满足用户目标，在此停止。仅在用户明确选择并希望继续时，才在当前 Execution 提交对应 rank。"
    : "Provider 已返回空结果；不要重放当前 execution，按下一步恢复。";
  let next: CommandAction | null = null;

  if (response.effective_quota?.exhausted) {
    status = "quota_exhausted";
    instruction = "免费额度已用完且本次未调用 Provider；先向用户说明价格并确认购买。";
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
      next = {
				command: quoteCommand(response.execution.service_execution_id, checkoutCapability, input),
				reason: "准备当前服务的付费 continuation 报价",
      };
    } else {
      next = {
        command: `itpay services next ${response.execution.service_execution_id} --json`,
        reason: "读取服务端提供的付费恢复入口",
      };
    }
  } else if (items.length > 0 && requestedCapability.requires_human_action) {
    next = {
			command: `itpay services action ${response.execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
			reason: "在当前 Execution 记录用户选择",
    };
  } else if (items.length === 0) {
    next = response.provider_called
      ? { command: `itpay services start ${response.execution.service_id}`, reason: "为新的服务输入启动新 execution" }
      : { command: `itpay services next ${response.execution.service_execution_id} --json`, reason: "读取服务端恢复动作" };
  }

  return {
    value: { status, result: baseResult, instruction, next, recovery: [] },
    plainResult: serviceResultPlainLines(baseResult),
  };
}

function serviceResultPlainLines(result: Record<string, unknown>): string[] {
  const lines = [
    `service_execution_id: ${String(result.service_execution_id)}`,
    `capability_id: ${String(result.capability_id)}`,
  ];
  if (result.quota) lines.push(`quota: ${JSON.stringify(result.quota)}`);
  if (result.checkout) lines.push(`checkout: ${JSON.stringify(result.checkout)}`);
  const items = result.items as Array<{ rank: number; title: string; safe_payload: Record<string, unknown> }>;
  if (items.length > 0) {
    lines.push("items:");
    for (const item of items) {
      lines.push(`  ${item.rank}. ${item.title}`);
      for (const [key, value] of Object.entries(item.safe_payload)) {
        lines.push(`     ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }
  }
  return lines;
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
): string {
  const lockedInput = { ...input };
  for (const field of missingRequiredInput(capability.input_schema, lockedInput)) lockedInput[field] = "<value>";
  return `itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)}${capability.delivery_email_required ? " --email <email>" : ""} --json`;
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
      : ` --input ${shellArgument(`${key}=${String(value)}`)}`)
    .join("");
}

function shellArgument(value: string): string {
	if (/^[\p{L}\p{N}._:=/-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
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
	const response = await backend.recordServiceExecutionAction(serviceExecutionID, request);
	if (selection && actionType === "select_candidate" && response.status === "approved") {
		const updated = await backend.getServiceExecution(serviceExecutionID);
		const preferred = updated.allowed_actions?.[0];
		const next = preferred ? serviceAllowedActionCommand(updated, preferred) : null;
		writeCommandEnvelope({
			status: "candidate_selected",
			result: {
				service_execution_id: response.service_execution_id,
				candidate: { rank: selection.rank, title: selection.title },
			},
			instruction: "候选已绑定到来源 Execution；后续动作必须继续使用该 Execution。",
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
    "使用当前 safe result 中的合法 action 和 candidate rank；需要人确认时先询问用户。",
    [{ command: `itpay services next ${serviceExecutionID} --json`, reason: "重新读取当前可选动作" }],
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
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
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
    if (missingInput.length > 0 && readModel.execution.next_action !== "create_checkout") {
      throw new CommandContractError(
        "capability_input_invalid",
        `missing required capability input: ${missingInput.join(", ")}`,
        "补齐付费 capability 的 required_input；本次没有创建 quote、Checkout 或订单。",
        [{ command: checkoutCommand(serviceExecutionID, capability, lockedInput), reason: "提交完整且会被锁定的服务输入" }],
      );
    }
    if (capability.delivery_email_required && String(deliveryContact.email ?? "").trim() === "") {
      throw new CommandContractError(
        "delivery_email_required",
        "delivery email is required before creating this service checkout",
        "该 capability 的交付链接会发送到用户邮箱；先向用户说明用途并询问邮箱，不要代填。",
        [{
          command: `itpay services checkout ${serviceExecutionID} --capability ${capability.capability_id}${formatInputOptions(lockedInput)} --email <email> --json`,
          reason: "使用用户提供的邮箱创建 Checkout",
        }],
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
  const checkoutURL = tokenizedCheckoutURL(checkout.checkout_url, displayToken, checkout.qr_payload);
  const plan = buildCheckoutQRPlan({
    host: options.host ?? "terminal",
    checkoutID,
    checkoutURL,
    displayToken,
    qrPayload: checkout.qr_payload,
    ...(checkout.qr_png_url ? { qrPNGURL: checkout.qr_png_url } : {}),
    nextAction: checkout.checkout.next_action,
    orderItems: response.cart.items.map((item) => ({
      title: item.title,
      quantity: item.quantity,
      amountMinor: item.amount_minor,
      currency: item.currency,
    })),
    orderCurrency: checkout.checkout.currency,
  });

  options.persistHandoff?.({
    serviceExecutionID,
    cartID: response.cart.cart_id,
    checkoutID,
    displayToken,
    checkoutURL,
  });

  const platform = platformKeyForHost(plan.host);
  if (platform === "telegram" || platform === "feishu" || platform === "lark") {
    await dispatchRender(plan, {
      host: options.host ?? "terminal",
      ...(options.target ? { target: options.target } : {}),
      ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
      ...(options.qrFilePath ? { qrFilePath: options.qrFilePath } : {}),
      ...(options.output ? { output: options.output } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      baseURL: config.baseURL,
    });
    return;
  }
  await ensureIdeImageAttach(plan, {
    enabled: config.ideImageAttach,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const envelope = buildServicesCheckoutEnvelope(response, checkoutURL, plan);
  const plainResult = [
    `service_execution_id: ${response.binding.service_execution_id}`,
    `checkout_id: ${checkoutID}`,
    `capability_id: ${checkoutCapabilityID(response, capabilityID)}`,
    `locked_input: ${JSON.stringify(response.locked_input)}`,
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
  if (missingInput.length > 0 && !selectionBacked) {
    throw new CommandContractError(
      "capability_input_invalid",
      `missing required capability input: ${missingInput.join(", ")}`,
      "补齐付费 capability 输入；本次没有创建 Quote、Cart 或 Checkout。",
      [{ command: quoteCommand(serviceExecutionID, capability, input), reason: "提交完整且会被锁定的输入" }],
    );
  }
  const deliveryContact = {
    ...(options.deliveryContact ?? {}),
    ...(options.email ? { email: options.email } : {}),
  };
  if (capability.delivery_email_required && String(deliveryContact.email ?? "").trim() === "") {
    throw new CommandContractError(
      "delivery_email_required",
      "delivery email is required before preparing this service quote",
      "交付链接会发送到用户邮箱；说明用途并询问邮箱，不要代填。",
      [{ command: quoteCommand(serviceExecutionID, capability, input), reason: "使用用户提供的邮箱创建报价" }],
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
    service_execution_id: execution.service_execution_id,
    service_id: execution.service_id,
    status: execution.status,
    phase: execution.phase,
    ...(execution.current_capability_id ? { current_capability_id: execution.current_capability_id } : {}),
    updated_at: execution.updated_at,
    timeline,
    ...(response.events.length > timeline.length ? { timeline_truncated: true } : {}),
    ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
    ...(lockedRefund ? {
      access_locked: true,
      refund: { refund_request_id: lockedRefund.refund_request_id, status: lockedRefund.status },
    } : {}),
  };
  const envelope: CommandEnvelope = {
    status: "shown",
    result,
    instruction: lockedRefund || isTerminalServiceExecutionStatus(execution.status)
      ? nextState.instruction
      : "时间线仅用于解释和恢复；按当前首选动作继续，不要重放已完成步骤。",
    next: nextState.next ? { command: nextState.next.command, reason: "继续当前首选动作" } : null,
    recovery: [{ command: `itpay services events ${serviceExecutionID} --json`, reason: "仅在需要完整诊断事件时使用" }],
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

export async function runServicesNext(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.getServiceExecution(serviceExecutionID);
  const envelope = servicesNextEnvelope(response);
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: servicesNextPlainResult(envelope.result),
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
  }));
  const latest = executions[0];
  const envelope: CommandEnvelope = {
    status: latest ? "listed" : "no_executions",
    result: { executions },
    instruction: latest
      ? "结果按最新到最旧排列，默认只列最近 10 条；找不到目标时再扩大 limit。"
      : "当前设备没有可恢复的 Service Execution；先读取已发布目录，不要猜测 ID。",
    next: latest
      ? { command: `itpay services next ${latest.service_execution_id} --json`, reason: "默认恢复最新执行" }
      : { command: "itpay catalog list --json", reason: "选择已发布服务" },
    recovery: [],
  };
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: executions.map((execution) =>
      `${execution.service_execution_id}: ${execution.service_id} ${execution.status}/${execution.phase} updated=${execution.updated_at}`,
    ),
  });
}

export async function runServicesReadResult(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const envelope = grantedResultEnvelope(await backend.getGrantedServiceResult(serviceExecutionID));
  writeCommandEnvelope(envelope, {
    ...(options.jsonOutput !== undefined ? { jsonOutput: options.jsonOutput } : {}),
    ...(options.output ? { output: options.output } : {}),
    plainResult: servicesNextPlainResult(envelope.result),
  });
}

function servicesNextEnvelope(model: ServiceExecutionReadModel): CommandEnvelope {
  const execution = model.execution;
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
        ? "退款已成功，交付永久关闭；不要 reveal、创建 grant 或读取结果。"
        : "退款处理中，交付已冻结；不要 reveal、创建 grant 或读取结果。",
      next: terminal ? null : {
        command: `itpay refund get ${lockedRefund.refund_request_id} --json`,
        reason: "读取退款权威状态",
      },
      recovery: [],
    };
  }
	if (isTerminalServiceExecutionStatus(execution.status)) {
    return {
      status: execution.status,
      result: {
        service_execution_id: execution.service_execution_id,
        service_id: execution.service_id,
        phase: execution.phase,
      },
      instruction: execution.status === "refunded"
        ? "该服务执行已退款并永久结束；不要重放 capability 或创建 Checkout。"
        : "该服务执行已结束；不要重放 capability 或创建 Checkout。",
      next: null,
      recovery: [{
        command: `itpay services events ${execution.service_execution_id} --json`,
        reason: "仅在需要诊断终止原因时读取事件",
      }],
		};
	}
	const currentItems = model.current_result_items ?? [];
	const candidateSelection = model.allowed_actions?.find((action) => action.type === "select_candidate");
	if (candidateSelection && currentItems.length > 0) {
		return {
			status: "candidate_selection_available",
			result: {
				service_execution_id: execution.service_execution_id,
				items: currentItems.map((item) => ({
					rank: item.rank,
					title: item.display_title,
					safe_payload: item.safe_payload,
				})),
			},
			instruction: "向用户展示编号和 safe_payload；若候选列表已满足用户目标，在此停止。仅在用户明确选择并希望继续时，才在当前 Execution 提交对应 rank。",
			next: {
				command: `itpay services action ${execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
				reason: "仅在用户明确选择后锁定来源候选",
			},
			recovery: [],
		};
	}
	const delivery = model.current_delivery ?? model.delivery_bindings.at(-1);
  const deliveryMode = serviceDeliveryMode(model);
  if (deliveryMode === "agent_visible_result") {
			const items = currentItems.map((item) => ({
      rank: item.rank,
      title: item.display_title,
      safe_payload: item.safe_payload,
    }));
		const selection = model.allowed_actions?.find((action) => action.type === "select_candidate");
		return {
      status: items.length > 0 ? "result_ready" : "no_result",
			result: {
				service_execution_id: execution.service_execution_id,
				...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
				delivery_mode: deliveryMode,
				items,
			},
			instruction: items.length > 0
				? selection
					? "这是当前 Graph 步骤对应的交付。向用户展示编号和 safe_payload；若已满足用户目标，在此停止。仅在用户明确选择并希望继续时，才提交对应 rank。"
					: "这是当前 Graph 步骤对应的交付；结果已可供 Agent 使用，只使用 safe_payload。"
				: "Agent-visible 交付已完成但没有结果项；不要调用 read-result 或重放当前 execution。",
			next: selection ? {
				command: `itpay services action ${execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank> --json`,
				reason: "仅在用户明确选择后锁定来源候选",
			} : null,
      recovery: items.length > 0 ? [] : [{ command: `itpay services get ${execution.service_execution_id} --json`, reason: "检查交付时间线" }],
    };
  }
  if (deliveryMode === "vault_artifact") {
    const grantStatus = normalizeGrantStatus(delivery?.grant_status);
    const grantActive = grantStatus === "active";
    return {
      status: grantActive ? "grant_active" : "human_authorization_required",
      result: {
        service_execution_id: execution.service_execution_id,
				...(delivery?.capability_id ? { capability_id: delivery.capability_id } : {}),
        delivery_mode: deliveryMode,
        grant_status: grantStatus,
        ...(grantActive && delivery?.grant_expires_at ? { grant_expires_at: delivery.grant_expires_at } : {}),
      },
      instruction: grantActive
			? "这是当前 Graph 步骤对应的交付；用户授权有效，立即读取并遵守字段范围与到期时间。"
			: "这是当前 Graph 步骤对应的交付；请用户在订单页面授权，未授权前不要读取或猜测内容。",
      next: {
        command: `itpay services read-result ${execution.service_execution_id} --json`,
        reason: grantActive ? "读取当前有效 grant 的结果" : "仅在用户确认授权后执行",
      },
      recovery: [],
    };
  }

	const allowedActions = model.allowed_actions ?? [];
	const preferred = allowedActions[0];
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
		instruction: preferred?.requires_human
			? "当前下一步需要用户明确选择；先展示必要信息并等待确认。"
			: preferred ? "执行服务端返回的唯一首选动作；不要猜测其他 capability。" : "当前没有后续动作。",
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
		if (!capability) return null;
		const selectionBacked = model.execution.status === "human_action_approved";
		const input = selectionBacked
			? {}
			: Object.fromEntries(requiredInputFields(capability.input_schema).map((field) => [field, "<value>"]));
		return {
			command: `itpay services quote ${executionID} --capability ${capability.capability_id}${formatInputOptions(input)}${capability.delivery_email_required ? " --email <email>" : ""} --json`,
			reason: selectionBacked ? "为已确认候选准备报价" : "为当前输入准备报价",
		};
	}
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
  const explicit = String(delivery?.redacted_summary?.delivery_mode ?? "");
  if (explicit) return explicit;
  return delivery?.vault_artifact_id ? "vault_artifact" : "";
}

function normalizeGrantStatus(status: string | undefined): string {
  return !status || status === "missing" ? "none" : status;
}

function grantedResultEnvelope(response: GrantedServiceResult): CommandEnvelope {
  return {
    status: "granted_result_ready",
    result: {
      service_execution_id: response.service_execution_id,
      ...(response.expires_at ? { grant_expires_at: response.expires_at } : {}),
      granted_fields: Object.keys(response.result),
      payload: response.result,
    },
    instruction: "结果来自当前有效 Vault Grant；只使用本次授权字段，过期后停止读取并重新请求用户同意。",
    next: null,
    recovery: [],
  };
}

function servicesNextPlainResult(result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (key === "items" && Array.isArray(value)) {
      lines.push("items:");
      for (const item of value as Array<{ rank: number; title: string; safe_payload: Record<string, unknown> }>) {
        lines.push(`  ${item.rank}. ${item.title}`);
        for (const [field, fieldValue] of Object.entries(item.safe_payload)) {
          lines.push(`     ${field}: ${typeof fieldValue === "string" ? fieldValue : JSON.stringify(fieldValue)}`);
        }
      }
      continue;
    }
    lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines;
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
    instruction: "事件仅用于诊断；不要从事件重放业务步骤，回到 services next 获取当前动作。",
    next: {
      command: `itpay services next ${serviceExecutionID} --json`,
      reason: "恢复正常服务流程",
    },
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
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}


function buildServicesCheckoutEnvelope(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  checkoutURL: string,
  plan: ReturnType<typeof buildCheckoutQRPlan>,
): CommandEnvelope {
  const checkout = response.checkout;
  const platform = platformKeyForHost(plan.host);
  const handoff: Record<string, unknown> = { url: checkoutURL };
  if (plan.ideImageAttach?.status === "downloaded" && plan.ideImageAttach.localPath) {
    handoff.qr_local_path = plan.ideImageAttach.localPath;
  }
  if (platform === "markdown") {
    handoff.markdown = buildAgentChatHandoff(plan).markdown;
  } else if (platform === "plain_chat" && checkout.qr_png_url) {
    handoff.qr_image_url = checkout.qr_png_url;
  }
  return {
    status: "human_checkout_required",
    result: {
      service_execution_id: response.binding.service_execution_id,
      checkout_id: checkout.checkout.checkout_id,
      capability_id: checkoutCapabilityID(response),
      locked_input: response.locked_input,
      amount: formatMoney(checkout.checkout.amount_minor, checkout.checkout.currency),
    },
    handoff,
    instruction: checkoutInstruction(platform),
    next: {
      command: `itpay checkout --id ${checkout.checkout.checkout_id} --token ${checkout.display_token}`,
      reason: "跟踪同一笔 Checkout",
    },
    recovery: [],
  };
}

function checkoutCapabilityID(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  fallback = "",
): string {
  return response.capability_id || fallback;
}

function checkoutInstruction(platform: ReturnType<typeof platformKeyForHost>): string {
  if (platform === "markdown") return "把 handoff.markdown 原样发送到当前桌面对话；二维码和链接可见前不要查询状态或新建 Checkout。";
  if (platform === "terminal") return "在用户可见终端展示二维码和付款链接；可见前不要查询状态或新建 Checkout。";
  return "把付款链接和可用二维码附件发送给用户；可见前不要查询状态或新建 Checkout。";
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
