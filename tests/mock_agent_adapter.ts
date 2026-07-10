export interface AgentInputField {
  id: string;
  inputType: string;
  required?: boolean;
}

export interface AgentInputRequestPayload {
  type: "itpay_input_request";
  id: string;
  submit_label?: string;
  fields: AgentInputField[];
}

// The markdown renderer outputs a fillable template (`{"email":"<email>"}`)
// without a top-level `type` field, so the mock adapter infers the
// request shape from the keys of the JSON code block.
export function extractInputRequestFromMarkdown(markdown: string): AgentInputRequestPayload {
  const matches = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)];
  for (const match of matches.reverse()) {
    const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 0) continue;
    const looksLikeTemplate = keys.every((key) => typeof parsed[key] === "string");
    if (!looksLikeTemplate) continue;
    const fields: AgentInputField[] = keys.map((key) => ({
      id: key,
      inputType: "<text>",
      required: false,
    }));
    return {
      type: "itpay_input_request",
      id: "inferred",
      fields,
    };
  }
  throw new Error("no itpay_input_request block found");
}

export function submitAgentInputRequest(
  request: AgentInputRequestPayload,
  values: Record<string, string>,
): Record<string, string> {
  for (const field of request.fields) {
    const value = values[field.id];
    if (field.required && (!value || value.trim().length === 0)) {
      throw new Error(`missing required field: ${field.id}`);
    }
  }
  return Object.fromEntries(request.fields.map((field) => [field.id, values[field.id] ?? ""]));
}
