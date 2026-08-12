import { HttpError } from "../client/http.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { declaredAgentType, qualifyItPayCommand } from "../state/agent_type.js";
import { qualifyBackendCommand } from "../state/config.js";

export interface CommandAction {
  command: string;
  reason: string;
}

export interface CommandEnvelope {
  status: string;
  result: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  instruction: string;
  next: CommandAction | null;
  recovery: CommandAction[];
}

interface CommandNullResultEnvelope extends Omit<CommandEnvelope, "result"> {
  result: null;
}

export interface CommandErrorEnvelope {
  status: "error";
  error: { code: string; message: string };
  result?: Record<string, unknown>;
  instruction: string;
  next: null;
  recovery: CommandAction[];
}

interface ErrorRecoveryAction {
  id: string;
  label: string;
  command: string;
  reason?: string;
}

export function isTerminalServiceExecutionStatus(status: string): boolean {
  return status === "failed" || status === "refunded" || status === "cancelled";
}

export class CommandContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instruction: string,
    readonly recovery: CommandAction[],
  ) {
    super(message);
    this.name = "CommandContractError";
  }
}

export function writeCommandEnvelope(
  value: CommandEnvelope | CommandNullResultEnvelope | CommandErrorEnvelope,
  options: { jsonOutput?: boolean; output?: OutputSink; plainResult?: string[]; agentType?: string } = {},
): void {
  const out = resolveOutput(options.output);
  const agentType = options.agentType ?? declaredAgentType();
  const qualified = qualifyEnvelope(value, agentType);
  if (options.jsonOutput) {
    out(JSON.stringify(qualified, null, 2) + "\n");
    return;
  }
  out(`${qualified.status}\n`);
  const facts = "error" in qualified ? qualified.error : qualified.result ?? {};
  if (options.plainResult) {
    for (const line of options.plainResult) out(`${line}\n`);
  } else {
    for (const [key, fact] of Object.entries(facts)) {
      out(`${key}: ${typeof fact === "string" ? fact : JSON.stringify(fact)}\n`);
    }
    if ("error" in qualified && qualified.result) {
      for (const [key, fact] of Object.entries(qualified.result)) {
        out(`${key}: ${typeof fact === "string" ? fact : JSON.stringify(fact)}\n`);
      }
    }
  }
  if ("handoff" in qualified && qualified.handoff) {
    for (const [key, fact] of Object.entries(qualified.handoff)) {
      out(`handoff.${key}: ${typeof fact === "string" ? fact : JSON.stringify(fact)}\n`);
    }
  }
  out(`instruction: ${qualified.instruction}\n`);
  if (qualified.next) out(`next: ${qualified.next.command}\n`);
  if (qualified.recovery.length > 0) {
    out("recovery:\n");
    for (const action of qualified.recovery) {
      out(`  - ${action.command}\n`);
      out(`    reason: ${action.reason}\n`);
    }
  }
}

function qualifyEnvelope<T extends CommandEnvelope | CommandNullResultEnvelope | CommandErrorEnvelope>(
  value: T,
  agentType: string | undefined,
): T {
  return {
    ...value,
    next: value.next ? { ...value.next, command: qualifyBackendCommand(qualifyItPayCommand(value.next.command, agentType)) } : null,
    recovery: value.recovery.map((action) => ({
      ...action,
      command: qualifyBackendCommand(qualifyItPayCommand(action.command, agentType)),
    })),
  };
}

export function errorRecoveryActions(error: unknown): ErrorRecoveryAction[] {
  if (!(error instanceof HttpError)) return [];
  if (error.code === "agent_identity_required") {
    return [{ id: "inspect_agent_setup", label: "Inspect supported Agent Type setup", command: "itpay install --json" }];
  }
  if (error.code === "agent_device_session_required") {
    return [{
      id: "read_agent_session_rules",
      label: "Read ItPay identity and session recovery rules",
      command: "itpay skill show itpay --json",
      reason: "The CLI already attempted one automatic session renewal; do not rotate identity or loop retries.",
    }];
  }
  if (error.code === "quota_exhausted" || error.code === "checkout_required") {
    return [{
      id: "inspect_service_execution",
      label: "Inspect Service Execution before checkout",
      command: "itpay services next <service_execution_id> --json",
    }];
  }
  if (error.code === "cart_item_locked" || error.status === 409) {
    return [
      { id: "show_cart", label: "Inspect the canonical server cart", command: "itpay cart show" },
      { id: "continue_checkout", label: "Continue the last locally remembered checkout", command: "itpay checkout" },
      {
        id: "recover_service_execution",
        label: "List recoverable Service Executions if the local handoff is missing",
        command: "itpay services list",
      },
    ];
  }
  if (error.status === 404) {
    return [{
      id: "recover_service_executions",
      label: "List visible Service Executions and follow their next instruction",
      command: "itpay services list",
    }];
  }
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return [{
      id: "retry_after_backend_recovers",
      label: "Retry after the selected official Backend is reachable",
      command: "itpay readyz",
    }];
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
