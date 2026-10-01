import { HttpError } from "../client/http.js";
import { resolveOutput, type OutputSink } from "../render/sink.js";
import { declaredAgentType, qualifyItPayCommand } from "../state/agent_type.js";
import { qualifyBackendCommand } from "../state/config.js";

export interface CommandAction {
  command: string;
  reason: string;
}

// input_template carries a command shape that is NOT directly executable —
// a required value (file path, rank, selection id) is still unknown. It must
// never appear in `next.command` or `recovery[].command`.
export interface InputTemplate {
  command: string;
  input?: Record<string, unknown>;
  required_input: string[];
  executable: false;
}

// itpay.interaction.v1 — the structured counterpart of `instruction`. Same
// semantic source, machine-readable goal branches. See
// docs/reviews/agent-ux-handoff-2026-09-23/03-CONTRACT-AND-RESOLVER.md.
export interface InteractionBlock {
  schema_version: "itpay.interaction.v1";
  stage: string;
  by_goal?: {
    compare?: Record<string, unknown>;
    prepare_checkout?: Record<string, unknown>;
  };
  input_template?: InputTemplate;
  recipe?: { id: string; for_goal?: string; steps: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

// itpay.communication.v1 — what must reach the human now and what we wait for.
export interface CommunicationBlock {
  schema_version: "itpay.communication.v1";
  status_line?: string;
  tell?: string;
  wait_for?: string;
  must_convey?: string[];
  next_expectation?: string;
  [key: string]: unknown;
}

export interface CommandEnvelope {
  status: string;
  result: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  instruction: string;
  next: CommandAction | null;
  recovery: CommandAction[];
  interaction?: InteractionBlock;
  communication?: CommunicationBlock;
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
  interaction?: InteractionBlock;
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

export function appendFeedbackPostmortemInstruction(instruction: string, outcome: "delivered" | "failed"): string {
  const invitation = outcome === "delivered"
    ? "结果解释完毕后，Agent 必须为同一订单提交一次安全服务复盘；用户评分和评论均可选，只在用户明确给出时忠实附上，不得猜分或上传对话、报告正文、联系方式和原始日志。"
    : "先完成同一订单的恢复和退款权利解释；处理清楚后，Agent 必须为同一订单提交一次安全服务复盘。只附上用户明确表达的评分或卡壳点，不得猜测。";
  return `${instruction} ${invitation}`;
}

export class CommandContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instruction: string,
    readonly recovery: CommandAction[],
    readonly interaction?: InteractionBlock,
  ) {
    super(message);
    this.name = "CommandContractError";
  }
}

// Domain projections and pages own byte limits; serialization never truncates facts.
export function plainValueLines(value: unknown, label = "", depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (value === null || typeof value !== "object") return [`${indent}${label ? `${label}: ` : ""}${String(value ?? "unknown")}`];
  const lines = label ? [`${indent}${label}:`] : [];
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v] as const) : Object.entries(value);
  for (const [key, child] of entries) lines.push(...plainValueLines(child, key, depth + (label ? 1 : 0)));
  if (!entries.length) lines.push(`${indent}  （无记录）`);
  return lines;
}

export function shellArgument(value: string): string {
  if (/^[\p{L}\p{N}._:=/-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function writeCommandEnvelope(
  value: CommandEnvelope | CommandNullResultEnvelope | CommandErrorEnvelope,
  options: { jsonOutput?: boolean; output?: OutputSink; plainResult?: string[]; agentType?: string } = {},
): void {
  const out = resolveOutput(options.output);
  const agentType = options.agentType ?? declaredAgentType();
  const qualified = qualifyEnvelope(value, agentType);
  if (options.jsonOutput) {
    const pretty = JSON.stringify(qualified, null, 2) + "\n";
    out(pretty);
    return;
  }
  out(`${qualified.status}\n`);
  const facts = "error" in qualified ? qualified.error : qualified.result ?? {};
  if (options.plainResult) {
    for (const line of options.plainResult) {
      const command = line.match(/^(\s*(?:command|reader|entry): )(itpay .*)$/);
      out(`${command ? command[1] + qualifyBackendCommand(qualifyItPayCommand(command[2]!, agentType)) : line}\n`);
    }
  } else {
    for (const [key, fact] of Object.entries(facts)) {
      for (const line of plainValueLines(fact, key)) out(`${line}\n`);
    }
    if ("error" in qualified && qualified.result) {
      for (const [key, fact] of Object.entries(qualified.result)) {
        for (const line of plainValueLines(fact, key)) out(`${line}\n`);
      }
    }
  }
  if ("handoff" in qualified && qualified.handoff) {
    for (const [key, fact] of Object.entries(qualified.handoff)) {
      for (const line of plainValueLines(fact, `handoff.${key}`)) out(`${line}\n`);
    }
  }
  out(`instruction: ${qualified.instruction}\n`);
  if (qualified.next) out(`next: ${qualified.next.command}\n  when: ${qualified.next.reason}\n`);
  if ("interaction" in qualified && qualified.interaction) {
    for (const line of plainValueLines(qualified.interaction, "interaction")) out(`${line}\n`);
  }
  if ("communication" in qualified && qualified.communication) {
    for (const line of plainValueLines(qualified.communication, "communication")) out(`${line}\n`);
  }
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
    result: qualifyCommandsDeep(value.result, agentType) as T["result"],
    ...("handoff" in value && value.handoff ? { handoff: qualifyCommandsDeep(value.handoff, agentType) as Record<string, unknown> } : {}),
    ...("interaction" in value && value.interaction ? { interaction: qualifyCommandsDeep(value.interaction, agentType) as InteractionBlock } : {}),
    ...("communication" in value && value.communication ? { communication: qualifyCommandsDeep(value.communication, agentType) as CommunicationBlock } : {}),
    next: value.next ? { ...value.next, command: qualifyBackendCommand(qualifyItPayCommand(value.next.command, agentType)) } : null,
    recovery: value.recovery.map((action) => ({
      ...action,
      command: qualifyBackendCommand(qualifyItPayCommand(action.command, agentType)),
    })),
  };
}

// Every `itpay ` command string anywhere in the envelope — result fields,
// interaction recipes/templates, available_actions — keeps the same Agent
// Type / Backend qualification as top-level next/recovery. Instruction prose
// never starts with "itpay " so prose stays untouched.
function qualifyCommandsDeep(value: unknown, agentType: string | undefined): unknown {
  if (typeof value === "string") {
    return value.startsWith("itpay ")
      ? qualifyBackendCommand(qualifyItPayCommand(value, agentType))
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => qualifyCommandsDeep(item, agentType));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, qualifyCommandsDeep(item, agentType)]),
    );
  }
  return value;
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
      command: "itpay services list --json",
    }];
  }
  if (error.code === "cart_item_locked") {
    return [{ id: "show_cart", label: "Inspect the locked cart", command: "itpay cart show --json",
      reason: "读取已有购物内容和订单锁，不创建替代 checkout。" }];
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
