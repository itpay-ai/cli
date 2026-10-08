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
