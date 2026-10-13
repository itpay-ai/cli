import { shellArgument, fileInputTemplate } from "./envelope.js";
import { requiredInputFields } from "./platform.js";

// Generate only declared required fields and preserve safe known query facts.
// Authorization and passenger identity are never synthesized into templates.
export function serviceInputTemplate(schema: Record<string, unknown>, known: Record<string, unknown> = {}): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const result: Record<string, unknown> = {};
  for (const field of new Set([...requiredInputFields(schema), ...Object.keys(known).filter(field => properties?.[field] !== undefined)])) {
    const rule = properties?.[field] ?? {};
    if (rule.type === "object") {
      const value = known[field];
      result[field] = serviceInputTemplate(rule, value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
    } else if (known[field] !== undefined && (rule.type === undefined || rule.type === "array" && Array.isArray(known[field]) || rule.type === "string" && typeof known[field] === "string" || rule.type === "boolean" && typeof known[field] === "boolean" || ["integer", "number"].includes(String(rule.type)) && typeof known[field] === "number")) result[field] = known[field];
    else if (rule.type === "boolean") result[field] = false;
    else if (rule.const !== undefined) result[field] = rule.const;
    else if (rule.type === "array") result[field] = [];
    else result[field] = `<${field}>`;
  }
  return result;
}

export interface OperationInputContext {
  serviceID: string;
  operationID?: string | undefined;
  executionID?: string | undefined;
  continuation?: { service_execution_id: string; snapshot_id: string } | undefined;
}
export function operationInputTemplate(context: OperationInputContext, input: Record<string, unknown>, required: string[] = []) {
  return fileInputTemplate(
    `itpay services run ${shellArgument(context.serviceID)}${context.operationID ? ` --operation ${shellArgument(context.operationID)}` : ""}${context.executionID ? ` --execution ${shellArgument(context.executionID)}` : ""} --input-json <file> --json`,
    context.operationID ? {input, ...(context.continuation ? {continuation: context.continuation} : {})} : input,
    required, {executionID: context.executionID});
}

export function executionInputContext(execution: import("../../client/types.js").ServiceExecution): OperationInputContext {
 const binding = execution.public_binding;
 return {serviceID: binding?.public_service_id ?? execution.service_id, executionID: execution.service_execution_id,
 ...(binding ? {operationID:binding.operation_id} : {}),
 ...(binding?.source_execution_id && binding.source_snapshot_id ? {continuation:{service_execution_id:binding.source_execution_id,snapshot_id:binding.source_snapshot_id}} : {})};
}
