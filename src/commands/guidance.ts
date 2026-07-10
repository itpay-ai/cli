import { HttpError } from "../client/http.js";
import type {
  Cart,
  LineItem,
  ServiceCapability,
  ServiceCapabilityInvoked,
  ServiceCapabilityResultItem,
  ServiceExecution,
  ServiceExecutionAction,
  ServiceDeliveryBinding,
  ServiceExecutionReadModel,
  ServiceExecutionStarted,
} from "../client/types.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";

export interface AgentNextAction {
  id: string;
  label: string;
  command: string;
  requires_human?: boolean;
  reason?: string;
}

export interface AgentGuidance {
  kind: string;
  summary: string;
  state: Record<string, unknown>;
  next_actions: AgentNextAction[];
  recovery: AgentNextAction[];
  visible_results?: Array<{ rank: number; title: string }>;
}

export function attachAgentGuidance<T>(
  payload: T,
  guidance: AgentGuidance,
): T & { agent_guidance: AgentGuidance } {
  return {
    ...(payload as object),
    agent_guidance: guidance,
  } as T & { agent_guidance: AgentGuidance };
}

export function printAgentGuidance(guidance: AgentGuidance, output?: OutputSink): void {
  const out = resolveOutput(output);
  out(`${guidance.summary}\n`);
  if (guidance.visible_results?.length) {
    out("results:\n");
    for (const item of guidance.visible_results) out(`  ${item.rank}. ${item.title}\n`);
  }
  if (guidance.next_actions.length === 0) {
    out("next actions: none\n");
  } else {
    out("next actions:\n");
    for (const action of guidance.next_actions) {
      out(`  - ${action.label}\n`);
      out(`    ${action.command}\n`);
      if (action.requires_human) out("    requires human confirmation\n");
      if (action.reason) out(`    reason: ${action.reason}\n`);
    }
  }
  if (guidance.recovery.length > 0) {
    out("recovery:\n");
    for (const action of guidance.recovery) {
      out(`  - ${action.label}\n`);
      out(`    ${action.command}\n`);
    }
  }
}

export function buildCartGuidance(cart: Cart, serviceModel?: ServiceExecutionReadModel): AgentGuidance {
  const serviceLine = latestServiceLine(cart);
  if (serviceLine?.service_execution_id) {
    const serviceGuidance = serviceModel
      ? buildServiceReadModelGuidance(serviceModel)
      : buildServiceHandleGuidance(serviceLine.service_execution_id, serviceLine.service_capability_id);
    return {
      ...serviceGuidance,
      kind: "cart_service_execution",
      summary: `cart ${cart.cart_id}: service-backed line ${lineID(serviceLine)} is ready for Service Execution`,
      state: {
        ...serviceGuidance.state,
        cart_id: cart.cart_id,
        cart_item_id: lineID(serviceLine),
        service_capability_id: serviceLine.service_capability_id,
      },
    };
  }
  if (cart.items.length === 0) {
    return {
      kind: "empty_cart",
      summary: `cart ${cart.cart_id}: empty`,
      state: { cart_id: cart.cart_id, status: cart.status },
      next_actions: [
        {
          id: "browse_catalog",
          label: "Browse services",
          command: "itpay catalog list",
        },
      ],
      recovery: [],
    };
  }
  return {
    kind: "cart_checkout_ready",
    summary: `cart ${cart.cart_id}: ready for checkout`,
    state: { cart_id: cart.cart_id, status: cart.status, amount_minor: cart.amount_minor, currency: cart.currency },
    next_actions: [
      {
        id: "checkout_cart",
        label: "Create ItPay checkout",
        command: `itpay buy --cart ${cart.cart_id} --host <client> --contact-email <email>`,
        requires_human: true,
        reason: "The human must review and pay on the ItPay checkout page.",
      },
    ],
    recovery: [
      {
        id: "show_cart",
        label: "Inspect current server cart",
        command: "itpay cart show",
      },
    ],
  };
}

export function buildServiceStartedGuidance(response: ServiceExecutionStarted): AgentGuidance {
  return buildServiceGuidance({
    execution: response.execution,
    capabilities: response.capabilities,
  });
}

export function buildServiceReadModelGuidance(model: ServiceExecutionReadModel): AgentGuidance {
  return buildServiceGuidance({
    execution: model.execution,
    capabilities: model.capabilities,
    resultItems: model.result_items,
    checkoutBindings: model.checkout_bindings,
    deliveryBindings: model.delivery_bindings,
  });
}

export function buildServiceInvokedGuidance(
  response: ServiceCapabilityInvoked,
  capabilities: ServiceCapability[] = [],
): AgentGuidance {
  return buildServiceGuidance({
    execution: response.execution,
    capabilities,
    resultItems: response.result_items,
    ...(response.next_actions ? { backendNextActions: response.next_actions } : {}),
    ...(response.effective_quota ? { effectiveQuota: response.effective_quota } : {}),
    providerCalled: response.provider_called,
  });
}

export function buildServiceActionGuidance(action: ServiceExecutionAction): AgentGuidance {
  const serviceExecutionID = action.service_execution_id;
  return {
    kind: "service_action_recorded",
    summary: `service execution ${serviceExecutionID}: action ${action.action_type} recorded`,
    state: {
      service_execution_id: serviceExecutionID,
      action_type: action.action_type,
      status: action.status,
      result_item_id: action.result_item_id,
      selected_candidate_hash: action.selected_candidate_hash,
    },
    next_actions: [
      {
        id: "inspect_service_execution",
        label: "Read updated Service Execution state",
        command: `itpay services next ${serviceExecutionID} --json`,
      },
    ],
    recovery: [
      {
        id: "timeline",
        label: "Inspect full timeline",
        command: `itpay services get ${serviceExecutionID}`,
      },
    ],
  };
}

export function buildServiceHandleGuidance(serviceExecutionID: string, checkoutCapabilityID?: string): AgentGuidance {
  const actions: AgentNextAction[] = [
    {
      id: "inspect_service_execution",
      label: "Read Service Execution state and capabilities",
      command: `itpay services next ${serviceExecutionID} --json`,
    },
  ];
  if (checkoutCapabilityID) {
    actions.push({
      id: "checkout_service",
      label: "Create checkout after human confirmation",
      command: `itpay services checkout ${serviceExecutionID} --capability ${checkoutCapabilityID} --json`,
      requires_human: true,
      reason: "Inspect the Service Execution first; the CLI will request delivery contact only when the selected capability requires it.",
    });
  }
  return {
    kind: "service_execution_handle",
    summary: `service execution ${serviceExecutionID}: inspect before invoking`,
    state: { service_execution_id: serviceExecutionID },
    next_actions: actions,
    recovery: [],
  };
}

export function errorRecoveryActions(error: unknown): AgentNextAction[] {
  if (!(error instanceof HttpError)) return [];
  if (error.code === "agent_identity_required") {
    return [
      {
        id: "set_agent_identity",
        label: "Set a stable agent device id",
        command: "export ITPAY_AGENT_DEVICE_ID=<stable_agent_device_id>",
      },
    ];
  }
  if (error.code === "quota_exhausted" || error.code === "checkout_required") {
    return [
      {
        id: "inspect_service_execution",
        label: "Inspect Service Execution before checkout",
        command: "itpay services next <service_execution_id> --json",
      },
    ];
  }
  if (error.code === "cart_item_locked" || error.status === 409) {
    return [
      {
        id: "show_cart",
        label: "Inspect the canonical server cart",
        command: "itpay cart show",
      },
      {
        id: "continue_checkout",
        label: "Continue the last locally remembered checkout",
        command: "itpay checkout",
      },
      {
        id: "recover_service_execution",
        label: "List recoverable Service Executions if the local handoff is missing",
        command: "itpay services list",
      },
    ];
  }
  if (error.status === 404) {
    return [
      {
        id: "recover_service_executions",
        label: "List visible Service Executions and follow their next instruction",
        command: "itpay services list",
      },
    ];
  }
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return [
      {
        id: "retry_after_backend_recovers",
        label: "Retry after the ItPay backend is reachable",
        command: "itpay readyz",
      },
      {
        id: "check_backend_url",
        label: "Check the configured backend URL",
        command: "echo $ITPAY_BACKEND_URL",
      },
    ];
  }
  return [];
}

export function printErrorRecovery(error: unknown, output?: OutputSink): void {
  const recovery = errorRecoveryActions(error);
  if (recovery.length === 0) return;
  const out = resolveOutput(output);
  out("recovery:\n");
  for (const action of recovery) {
    out(`  - ${action.label}\n`);
    out(`    ${action.command}\n`);
  }
}

function buildServiceGuidance(input: {
  execution: ServiceExecution;
  capabilities?: ServiceCapability[];
  resultItems?: ServiceCapabilityResultItem[];
  checkoutBindings?: Array<{ checkout_id: string }>;
  deliveryBindings?: ServiceDeliveryBinding[];
  checkoutCapabilityID?: string;
  backendNextActions?: Array<{ kind: string; capability_id?: string; requires_human: boolean }>;
  effectiveQuota?: { bucket: string; remaining: number; limit: number; exhausted: boolean; replenishment: string };
  providerCalled?: boolean;
}): AgentGuidance {
  const execution = input.execution;
  const capabilities = input.capabilities ?? [];
  const prePurchase = firstPrePurchaseCapability(capabilities);
  const paid = firstPaidCapability(capabilities);
  const resultItem = input.resultItems?.[0];
  const checkoutID = input.checkoutBindings?.at(-1)?.checkout_id;
  const delivery = input.deliveryBindings?.[0];
  const backendCheckout = input.backendNextActions?.find((action) => action.kind === "create_checkout");
  const nextActions: AgentNextAction[] = [];
  const recovery: AgentNextAction[] = [
    {
      id: "timeline",
      label: "Inspect full timeline",
      command: `itpay services get ${execution.service_execution_id}`,
    },
  ];

  if (execution.status === "completed" || execution.next_action === "completed") {
    nextActions.push({
      id: "inspect_order_or_grant",
      label: "Inspect order, claim, or grant from the checkout/order owner",
      command: "itpay orders --limit 20",
      requires_human: true,
      reason: "Delivery visibility is controlled by the human account and grant flow.",
    });
  } else if (execution.phase === "delivery" || execution.next_action === "view_delivery") {
    const grantStatus = String(delivery?.grant_status ?? "");
    if (grantStatus === "active") {
      nextActions.push({
        id: "read_granted_result",
        label: "Read the human-granted service result",
        command: `itpay services read-result ${execution.service_execution_id}`,
        reason: "The human granted temporary agent access to this delivery.",
      });
    } else {
      nextActions.push({
        id: grantStatus === "expired" ? "ask_human_to_reauthorize" : "wait_for_human_agent_grant",
        label: grantStatus === "expired" ? "Ask the human to authorize AI access again" : "Wait for human AI-access authorization",
        command: `itpay services get ${execution.service_execution_id}`,
        requires_human: true,
        reason: grantStatus === "expired"
          ? "The 15 minute human grant expired."
          : "The human must approve AI access on the Credential page.",
      });
    }
  } else if (execution.next_action === "pay_checkout" || execution.status === "checkout_pending") {
    nextActions.push({
      id: "open_existing_checkout",
      label: "Open the existing ItPay checkout handoff",
      command: `itpay services checkout ${execution.service_execution_id} --resume --json`,
      requires_human: true,
      reason: checkoutID
        ? `Checkout ${checkoutID} already exists; reissue a short-lived handoff without creating another checkout.`
        : "Recover the existing checkout handoff from Service Execution owner facts.",
    });
  } else if (execution.checkout_required || execution.next_action === "create_checkout") {
    const capabilityID = backendCheckout?.capability_id ?? paid?.capability_id ?? input.checkoutCapabilityID ?? execution.current_capability_id;
    if (capabilityID) {
      const checkoutCapability = capabilities.find((capability) => capability.capability_id === capabilityID);
      const emailRequired = checkoutCapability?.delivery_email_required === true;
      nextActions.push({
        id: "checkout_service",
        label: "Create ItPay checkout for the paid service capability",
        command: `itpay services checkout ${execution.service_execution_id} --capability ${capabilityID}${emailRequired ? " --email <email>" : ""} --json`,
        requires_human: true,
        reason: emailRequired
          ? "Ask the human for their email. It is used to send the protected result claim link; never invent or substitute an address."
          : "This capability returns an agent-visible result after payment and does not require a delivery email.",
      });
    } else {
      nextActions.push({
        id: "inspect_capabilities",
        label: "Inspect capabilities before checkout",
        command: `itpay services get ${execution.service_execution_id}`,
      });
    }
  } else if (input.providerCalled && (input.resultItems?.length ?? 0) === 0) {
    nextActions.push({
      id: "refine_search",
      label: "Ask for a more specific company name before another lookup",
      command: `itpay services invoke ${execution.service_execution_id} --capability ${execution.current_capability_id ?? "<capability_id>"} --input keyword=<more_specific_company_name>`,
      requires_human: true,
      reason: "The provider returned no candidates. Do not repeat the same query.",
    });
  } else if (needsHumanSelection(execution, resultItem)) {
    nextActions.push({
      id: "select_result_item",
      label: "Ask the human to select a result item, then submit the selection",
      command: `itpay services action ${execution.service_execution_id} --action select_candidate --actor-type human --status approved --candidate <rank>`,
      requires_human: true,
      reason: "Do not choose a candidate without explicit human confirmation.",
    });
  } else if (prePurchase) {
    const action: AgentNextAction = {
      id: "invoke_capability",
      label: `Invoke ${prePurchase.capability_id}`,
      command: `itpay services invoke ${execution.service_execution_id} --capability ${prePurchase.capability_id} --input key=value --json`,
    };
    if (prePurchase.free_quota_limit) {
      action.reason = `Free quota limit: ${prePurchase.free_quota_limit} per ${prePurchase.quota_subject || "subject"}.`;
    }
    nextActions.push(action);
  } else {
    nextActions.push({
      id: "inspect_service_execution",
      label: "Read Service Execution state",
      command: `itpay services next ${execution.service_execution_id} --json`,
    });
  }

  return {
    kind: "service_execution",
    summary: `service execution ${execution.service_execution_id}: ${execution.status}/${execution.phase}${input.effectiveQuota ? `, quota ${input.effectiveQuota.remaining}/${input.effectiveQuota.limit}` : ""}`,
    state: {
      service_execution_id: execution.service_execution_id,
      service_id: execution.service_id,
      status: execution.status,
      phase: execution.phase,
      current_capability_id: execution.current_capability_id,
      checkout_required: execution.checkout_required,
      next_action: execution.next_action,
      delivery: delivery
        ? {
            status: delivery.status,
            vault_artifact_id: delivery.vault_artifact_id,
            vault_status: delivery.vault_status,
            vault_payload_state: delivery.vault_payload_state,
            reveal_status: delivery.reveal_status,
            grant_status: delivery.grant_status ?? "missing",
            grant_expires_at: delivery.grant_expires_at,
          }
        : undefined,
      capabilities: capabilities.map((capability) => ({
        capability_id: capability.capability_id,
        agent_visible: capability.agent_visible,
        requires_payment: capability.requires_payment,
        vault_required: capability.vault_required,
        delivery_email_required: capability.delivery_email_required,
        price_amount_minor: capability.price_amount_minor,
        price_currency: capability.price_currency,
        free_quota_limit: capability.free_quota_limit,
      })),
      result_items: (input.resultItems ?? []).map((item) => ({
        result_item_id: item.service_capability_result_item_id,
        stable_hash: item.stable_hash,
        rank: item.rank,
        display_title: item.display_title,
      })),
      effective_quota: input.effectiveQuota,
    },
    next_actions: nextActions,
    recovery,
    ...(input.resultItems?.length
      ? { visible_results: input.resultItems.map((item) => ({ rank: item.rank, title: item.display_title })) }
      : {}),
  };
}

function firstPrePurchaseCapability(capabilities: ServiceCapability[]): ServiceCapability | undefined {
  return capabilities.find((capability) => capability.agent_visible && !capability.requires_payment)
    ?? capabilities.find((capability) => capability.agent_visible);
}

function firstPaidCapability(capabilities: ServiceCapability[]): ServiceCapability | undefined {
  return (
    capabilities.find((capability) => capability.requires_payment && capability.vault_required) ??
    capabilities.find((capability) => capability.requires_payment)
  );
}

function needsHumanSelection(execution: ServiceExecution, resultItem: ServiceCapabilityResultItem | undefined): boolean {
  if (execution.phase !== "pre_purchase") return false;
  return execution.next_action === "select_candidate" || execution.next_action === "human_action_required" || resultItem !== undefined;
}

function latestServiceLine(cart: Cart): LineItem | undefined {
  return [...cart.items].reverse().find((item) => item.service_execution_id);
}

function lineID(line: LineItem): string {
  return line.cart_item_id ?? line.line_item_id ?? line.checkout_item_id ?? "<unknown_line>";
}
