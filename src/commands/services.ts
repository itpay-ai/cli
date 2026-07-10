import type { BackendClient } from "../client/backend.js";
import type { RecordServiceExecutionActionRequest } from "../client/types.js";
import { operationID, type CLIConfig } from "../state/config.js";
import type { ClientHost } from "../state/client_context.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { dispatchRender, type DispatchOptions } from "../render/index.js";
import { ensureIdeImageAttach } from "../render/ide.js";
import { buildAgentChatHandoff } from "../render/markdown.js";
import { buildCheckoutQRPlan } from "./buy.js";
import {
  attachAgentGuidance,
  buildServiceActionGuidance,
  buildServiceInvokedGuidance,
  buildServiceReadModelGuidance,
  buildServiceStartedGuidance,
  printAgentGuidance,
} from "./guidance.js";

export interface ServicesCommandOptions {
  output?: OutputSink;
}

const serviceActionStatuses = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);

export async function runServicesStart(
  backend: BackendClient,
  config: CLIConfig,
  serviceID: string,
  options: ServicesCommandOptions & { buyerID?: string; host?: string; target?: string; clientContext?: Record<string, unknown> } = {},
): Promise<void> {
  const host = options.host ?? "terminal";
  const response = await backend.startServiceExecution({
    service_id: serviceID,
    agent_device_id: config.agentDeviceID,
    ...(options.buyerID ? { buyer_id: options.buyerID } : {}),
    client_context: {
      agent_device_id: config.agentDeviceID,
      host,
      ...(options.target ? { target: options.target } : {}),
      ...(options.clientContext ?? {}),
    },
  });
  writeJSON(options.output, attachAgentGuidance(response, buildServiceStartedGuidance(response)));
}

export async function runServicesInvoke(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string,
  input: Record<string, unknown>,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const idempotencyKey = await operationID(config, `service.invoke:${serviceExecutionID}:${capabilityID}:${stableInput(input)}`);
  const response = await backend.invokeServiceCapability(serviceExecutionID, capabilityID, {
    idempotency_key: idempotencyKey,
    redacted_summary: input,
  });
  const guidance = buildServiceInvokedGuidance(response);
  if (options.jsonOutput) {
    writeJSON(options.output, attachAgentGuidance(response, guidance));
    return;
  }
  printAgentGuidance(guidance, options.output);
}

function stableInput(input: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
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
    selectedCandidateHash?: string;
    candidateRank?: number;
    requiredBefore?: string;
  } = {},
): Promise<void> {
  const selection = await resolveCandidateSelection(backend, serviceExecutionID, actionType, options);
  const request: RecordServiceExecutionActionRequest = {
    action_type: actionType,
    input_snapshot: input,
  };
  if (options.actorType) request.actor_type = options.actorType;
  if (options.actorID) request.actor_id = options.actorID;
  if (options.status) request.status = normalizeServiceActionStatus(options.status);
  const resultItemID = selection?.resultItemID ?? options.resultItemID;
  const selectedCandidateHash = selection?.stableHash ?? options.selectedCandidateHash;
  if (resultItemID) request.result_item_id = resultItemID;
  if (selectedCandidateHash) request.selected_candidate_hash = selectedCandidateHash;
  if (options.requiredBefore) request.required_before = options.requiredBefore;
  const response = await backend.recordServiceExecutionAction(serviceExecutionID, request);
  writeJSON(options.output, attachAgentGuidance(response, buildServiceActionGuidance(response)));
}

async function resolveCandidateSelection(
  backend: BackendClient,
  serviceExecutionID: string,
  actionType: string,
  options: { candidateRank?: number; resultItemID?: string; selectedCandidateHash?: string },
): Promise<{ resultItemID: string; stableHash: string } | undefined> {
  if (options.candidateRank === undefined) return undefined;
  if (actionType !== "select_candidate") {
    throw new Error("--candidate is only valid with --action select_candidate");
  }
  if (options.resultItemID || options.selectedCandidateHash) {
    throw new Error("--candidate cannot be combined with --result-item or --selected-candidate-hash");
  }
  if (!Number.isInteger(options.candidateRank) || options.candidateRank < 1) {
    throw new Error("--candidate must be a positive integer result rank");
  }
  const execution = await backend.getServiceExecution(serviceExecutionID);
  const result = execution.result_items.find((item) => item.rank === options.candidateRank);
  if (!result) {
    throw new Error(`candidate ${options.candidateRank} is not available on service execution ${serviceExecutionID}`);
  }
  return {
    resultItemID: result.service_capability_result_item_id,
    stableHash: result.stable_hash,
  };
}

export async function runServicesCheckout(
  backend: BackendClient,
  config: CLIConfig,
  serviceExecutionID: string,
  capabilityID: string | undefined,
  options: ServicesCommandOptions & {
    email?: string;
    deliveryContact?: Record<string, unknown>;
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
		throw new Error("--capability is required when creating a service checkout; use --resume to recover an existing handoff");
	}
	if (!options.resume && String(deliveryContact.email ?? "").trim() === "") {
		const execution = await backend.getServiceExecution(serviceExecutionID);
		const capability = execution.capabilities.find((item) => item.capability_id === capabilityID);
		if (!capability) {
			throw new Error(`capability ${capabilityID} is not available on service execution ${serviceExecutionID}`);
		}
		if (capability.delivery_email_required) {
			throw new Error("delivery email is required before creating this service checkout; ask the buyer for --email");
		}
	}
  const response = await backend.createServiceExecutionCheckout(serviceExecutionID, {
    ...(capabilityID ? { capability_id: capabilityID } : {}),
    ...(Object.keys(deliveryContact).length > 0 ? { delivery_contact: deliveryContact } : {}),
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

  if (options.jsonOutput) {
    await ensureIdeImageAttach(plan, {
      enabled: config.ideImageAttach,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    writeJSON(options.output, buildServicesCheckoutJSON(response, checkoutURL, plan));
    return;
  }

  await dispatchRender(plan, {
    host: options.host ?? "terminal",
    isTTY: options.isTTY ?? Boolean(process.stdout.isTTY),
    ...(options.target ? { target: options.target } : {}),
    ...(options.qrFormat ? { qrFormat: options.qrFormat } : {}),
    ...(options.qrFilePath ? { qrFilePath: options.qrFilePath } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    baseURL: config.baseURL,
  });
}

export async function runServicesGet(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.getServiceExecution(serviceExecutionID);
  const guidance = buildServiceReadModelGuidance(response);
  if (options.jsonOutput) {
    writeJSON(options.output, attachAgentGuidance(response, guidance));
    return;
  }
  printAgentGuidance(guidance, options.output);
}

export async function runServicesNext(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions & { jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.getServiceExecution(serviceExecutionID);
  const guidance = buildServiceReadModelGuidance(response);
  if (options.jsonOutput) {
    writeJSON(options.output, guidance);
    return;
  }
  printAgentGuidance(guidance, options.output);
}

export async function runServicesList(
  backend: BackendClient,
  options: ServicesCommandOptions & { limit?: number; jsonOutput?: boolean } = {},
): Promise<void> {
  const response = await backend.listServiceExecutions(options.limit ?? 50);
  if (options.jsonOutput) {
    writeJSON(options.output, response.executions.map((model) => ({
      execution: model.execution,
      agent_guidance: buildServiceReadModelGuidance(model),
    })));
    return;
  }
  const out = resolveOutput(options.output);
  for (const model of response.executions) {
    const guidance = buildServiceReadModelGuidance(model);
    out(`${guidance.summary}\n`);
    const next = guidance.next_actions[0];
    if (next) out(`next: ${next.command}\n`);
  }
}

export async function runServicesReadResult(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions = {},
): Promise<void> {
  writeJSON(options.output, await backend.getGrantedServiceResult(serviceExecutionID));
}

export async function runServicesEvents(
  backend: BackendClient,
  serviceExecutionID: string,
  options: ServicesCommandOptions = {},
): Promise<void> {
  writeJSON(options.output, await backend.listServiceExecutionEvents(serviceExecutionID));
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

function writeJSON(output: OutputSink | undefined, value: unknown): void {
  resolveOutput(output)(JSON.stringify(value, null, 2) + "\n");
}

function buildServicesCheckoutJSON(
  response: Awaited<ReturnType<BackendClient["createServiceExecutionCheckout"]>>,
  checkoutURL: string,
  plan: ReturnType<typeof buildCheckoutQRPlan>,
): Record<string, unknown> {
  const checkout = response.checkout;
  const output: Record<string, unknown> = {
    kind: "checkout_handoff_required",
    next_action: "open_human_checkout",
    service_execution_id: response.binding.service_execution_id,
    service_quote_lock_id: response.service_quote_lock_id,
    checkout_id: checkout.checkout.checkout_id,
    checkout_status: checkout.checkout.status,
    handoff_reissued: response.handoff_reissued,
    checkout_url: checkoutURL,
    display_token: checkout.display_token,
    qr_payload: checkout.qr_payload,
    amount_minor: checkout.checkout.amount_minor,
    currency: checkout.checkout.currency,
    next: `itpay checkout --id ${checkout.checkout.checkout_id} --token ${checkout.display_token}`,
    warning: "Do not call `itpay pay` for the normal buyer flow; show this ItPay checkout URL/QR to the human.",
  };
  const nextActions = [{
    id: "open_human_checkout",
    label: "Show the ItPay checkout URL or branded QR to the human",
    command: `itpay checkout --id ${checkout.checkout.checkout_id} --token ${checkout.display_token}`,
    requires_human: true,
    reason: "The human must review and pay on the ItPay checkout page.",
  }];
  output.next_actions = nextActions;
  output.agent_guidance = {
    kind: "checkout_handoff",
    summary: `checkout ${checkout.checkout.checkout_id}: show the ItPay checkout handoff to the human`,
    state: {
      service_execution_id: response.binding.service_execution_id,
      checkout_id: checkout.checkout.checkout_id,
      checkout_status: checkout.checkout.status,
    },
    next_actions: nextActions,
    recovery: [{
      id: "inspect_checkout",
      label: "Read checkout presentation",
      command: `itpay checkout --id ${checkout.checkout.checkout_id} --token ${checkout.display_token}`,
    }],
  };
  if (checkout.qr_png_url) {
    output.qr_png_url = checkout.qr_png_url;
  }
  if (plan.ideImageAttach) {
    output.brand_qr_status = plan.ideImageAttach.status;
    output.brand_qr_mime_type = plan.ideImageAttach.mimeType;
    output.brand_qr_must_render_reason = plan.ideImageAttach.mustRenderReason;
    output.brand_qr_render_action = "agent_must_read_local_path_into_ide_chat";
    if (plan.ideImageAttach.localPath) {
      output.brand_qr_local_path = plan.ideImageAttach.localPath;
      const stableName = plan.ideImageAttach.localPath.split("/").pop();
      if (stableName) output.brand_qr_stable_name = stableName;
    }
    if (plan.ideImageAttach.mirrors.length > 0) {
      output.brand_qr_mirrors = [...plan.ideImageAttach.mirrors];
    }
    if (plan.ideImageAttach.caption) {
      output.brand_qr_caption = plan.ideImageAttach.caption;
    }
    if (plan.ideImageAttach.error) {
      output.brand_qr_error = plan.ideImageAttach.error;
    }
  }
  output.agent_action = buildAgentChatHandoff(plan);
  return output;
}

function normalizeServiceActionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (!serviceActionStatuses.has(normalized)) {
    throw new Error(
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
