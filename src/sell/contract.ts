/** Canonical Sell command/tool contract. Vendored into the standalone CLI by scripts/v3/sync-sell-contract.mjs. */
export type SellField = "string" | "number" | "object" | "array" | "document";
export interface SellOperation {
    command: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    scope: string;
    fields: Record<string, SellField>;
    optional?: string[];
    description: string;
    confirmation?: boolean;
}
const org = "/v1/seller/organizations/{merchant_id}";
const draft = `${org}/service-drafts/{draft_id}`;
const read = "itpay.seller.read", write = "itpay.seller.write", test = "itpay.seller.test", submit = "itpay.seller.submit";
export const SELL_GUIDE = {
    version: "itpay.sell.v1", command: "itpay sell", truth: "workflow.yaml",
    steps: ["auth", "setup", "sources", "workflow", "local_test", "confirm", "push", "platform_verification", "pricing", "submission", "publication"],
    rules: [
        "Use the authenticated user's existing merchant. KYB and payout changes remain in the dashboard.",
        "Resolve every API against its declared method, Content-Type, parameters, response schema and locked version. Ask for missing inputs; never guess credentials or change contracts.",
        "Only saved versions may run. A run is not a saved version. Local evidence cannot grant platform test approval.",
        "Use the platform node catalog and validator for supported pricing, quotas, confirmation and durable fulfillment. Every paid success path must cross payment and delivery gates.",
        "Use own credentials for local requests. Platform-managed credentials stay on the platform. Mark execution location honestly.",
        "Present side effects before live tests. Unknown results stop automatic retries. Local payment/refund/delivery gates are simulated, never real funds.",
        "Show the exact workflow and version before user confirmation. Preview price, delivery and current terms before explicit submission approval.",
        "Use platform guide for next actions. Submission is not publication: only an actual admin approval publishes the service."
    ]
} as const;
export const SELL_OPERATIONS: SellOperation[] = [
    { command: "status", method: "GET", path: "/v1/seller/organizations", scope: read, fields: {}, description: "List existing merchant memberships" },
    { command: "guide", method: "GET", path: `${org}/guide`, scope: read, fields: { draft_id: "string" }, optional: ["draft_id"], description: "Read authoritative publication blockers and next actions" },
    { command: "library search", method: "GET", path: "/v1/library/apis", scope: read, fields: { q: "string" }, optional: ["q"], description: "Search available API contracts" },
    { command: "library get", method: "GET", path: "/v1/library/apis/{library_api_id}", scope: read, fields: {}, description: "Inspect an API contract" },
    { command: "sources list", method: "GET", path: `${org}/api-intakes`, scope: read, fields: {}, description: "List imported API sources" },
    { command: "sources inspect", method: "GET", path: `${org}/api-intakes/{intake_id}`, scope: read, fields: {}, description: "Inspect imported operations and verification results" },
    { command: "sources import", method: "POST", path: `${org}/api-intakes`, scope: write, fields: { provider_key: "string", source_url: "string", document: "document", media_type: "string" }, optional: ["source_url", "document", "media_type"], description: "Import an OpenAPI source without inventing request contracts" },
    { command: "sources library", method: "POST", path: `${org}/api-intakes/from-library`, scope: write, fields: { library_api_id: "string" }, description: "Bind a platform library source" },
    { command: "sources probe", method: "POST", path: `${org}/api-intakes/{intake_id}/probe`, scope: test, fields: { credential_profile_id: "string", operation_inputs: "object" }, description: "Verify selected API requests on the platform", confirmation: true },
    { command: "credentials status", method: "GET", path: `${org}/provider-credential-profiles`, scope: read, fields: {}, description: "Read credential bindings without secret values" },
    { command: "services list", method: "GET", path: `${org}/service-drafts`, scope: read, fields: {}, description: "List own service drafts and publication state" },
    { command: "services create", method: "POST", path: `${org}/service-drafts`, scope: write, fields: { service_id: "string", public_name: "string" }, description: "Create a platform service draft" },
    { command: "services icon", method: "PUT", path: `${draft}/icon/content`, scope: write, fields: { content_base64: "string" }, description: "Upload a PNG/JPEG service icon, max 512 KiB, as signed JSON" },
    { command: "services get", method: "GET", path: `${draft}/workflow`, scope: read, fields: {}, description: "Read the current workflow and service settings" },
    { command: "workflow catalog", method: "GET", path: `${org}/node-catalog`, scope: read, fields: {}, description: "Read exact supported node templates and required configuration" },
    { command: "workflow plan", method: "POST", path: `${draft}/orchestration-runs`, scope: test, fields: { expected_revision: "number", instruction: "string", api_intake_ids: "array", credential_profile_bindings: "object" }, description: "Explicitly use ItPay AI planning and platform verification", confirmation: true },
    { command: "workflow plan-get", method: "GET", path: `${draft}/orchestration-runs/{run_id}`, scope: read, fields: {}, description: "Read the AI candidate and diagnostics" },
    { command: "workflow plan-apply", method: "POST", path: `${draft}/orchestration-runs/{run_id}/apply`, scope: write, fields: { expected_revision: "number" }, description: "Apply a reviewed AI candidate to the draft", confirmation: true },
    { command: "workflow upload", method: "PUT", path: `${draft}/workflow`, scope: write, fields: { expected_revision: "number", public_name: "string", arazzo: "object" }, optional: ["public_name"], description: "Update the platform workflow with optimistic concurrency" },
    { command: "workflow validate-platform", method: "POST", path: `${draft}/workflow/validate`, scope: write, fields: {}, description: "Validate using the same public runtime rules as approval" },
    { command: "workflow versions list-platform", method: "GET", path: `${draft}/workflow/versions`, scope: read, fields: {}, description: "List explicitly saved platform versions" },
    { command: "workflow versions save-platform", method: "POST", path: `${draft}/workflow/versions`, scope: write, fields: { name: "string", source: "string", arazzo_document: "string", expected_revision: "number" }, description: "Save an explicit immutable platform version" },
    { command: "workflow versions delete-platform", method: "DELETE", path: `${draft}/workflow/versions/{version_id}`, scope: write, fields: { expected_revision: "number" }, description: "Delete an eligible saved version and its runs", confirmation: true },
    { command: "fixtures get", method: "GET", path: `${draft}/fixtures`, scope: read, fields: {}, description: "Read test inputs" },
    { command: "fixtures set", method: "PUT", path: `${draft}/fixtures`, scope: write, fields: { expected_revision: "number", fixtures: "array" }, description: "Save explicit test inputs" },
    { command: "pricing get", method: "GET", path: `${draft}/workflow`, scope: read, fields: {}, description: "Read the current price and refund policy" },
    { command: "pricing set", method: "PUT", path: `${draft}/pricing`, scope: write, fields: { expected_revision: "number", pricing: "object", policy: "object" }, description: "Set per-call price and platform refund policy" },
    { command: "verify", method: "POST", path: `${draft}/validation-runs`, scope: test, fields: { workflow_version_id: "string", expected_semantic_revision: "number", expected_fixture_revision: "number" }, description: "Start platform verification for an explicitly saved version", confirmation: true },
    { command: "tests start-checkout", method: "POST", path: `${draft}/live-checkout-tests`, scope: test, fields: { expected_revision: "number", agent_instance_id: "string" }, description: "Dev admin only: freeze one success fixture into a private real-checkout test bound to your registered Agent. Payment still requires user confirmation; this does not publish the service.", confirmation: true },
    { command: "tests accept-checkout", method: "POST", path: `${draft}/live-checkout-tests/{execution_id}/accept`, scope: test, fields: {}, description: "Record server-observed issued tickets and completed delivery as evidence for the exact tested revision. Never synthesizes payment or issuance.", confirmation: true },
    { command: "runs get", method: "GET", path: `${draft}/validation-runs/{run_id}`, scope: read, fields: {}, description: "Inspect platform test nodes and diagnostics" },
    { command: "runs confirm", method: "POST", path: `${draft}/validation-runs/{run_id}/confirm`, scope: test, fields: { risk_hash: "string" }, description: "Confirm the exact disclosed platform test side effects", confirmation: true },
    { command: "submission preview", method: "GET", path: `${org}/guide`, scope: read, fields: { draft_id: "string" }, description: "Read publication readiness and required agreements" },
    { command: "submission submit", method: "POST", path: `${draft}/submit`, scope: submit, fields: { expected_revision: "number", terms_version: "string", confirmations: "array" }, description: "Submit the confirmed version for review, never approve it", confirmation: true },
    { command: "submission get", method: "GET", path: `${org}/service-submissions/{submission_id}`, scope: read, fields: {}, description: "Read the actual review/publication result" },
    { command: "submission withdraw", method: "POST", path: `${org}/service-submissions/{submission_id}/withdraw`, scope: submit, fields: {}, description: "Withdraw own pending submission", confirmation: true },
];
export function sellRequest(operation: SellOperation, params: Record<string, unknown>, input: Record<string, unknown> = {}) {
    let path = operation.path.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = params[key];
        if (typeof value !== "string" || !value.trim())
            throw new Error(`${key} is required`);
        return encodeURIComponent(value);
    });
    for (const key of Object.keys(input))
        if (!operation.fields[key])
            throw new Error(`Unsupported field: ${key}`);
    for (const [key, type] of Object.entries(operation.fields)) {
        const value = input[key];
        if (value === undefined && operation.optional?.includes(key))
            continue;
        const valid = type === "document" ? (typeof value === "string" || (!!value && typeof value === "object" && !Array.isArray(value))) : type === "array" ? Array.isArray(value) : type === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : typeof value === type;
        if (!valid)
            throw new Error(`${key} must be ${type}`);
        if (type === "number" && (!Number.isSafeInteger(value) || Number(value) < 0))
            throw new Error(`${key} must be a nonnegative integer`);
    }
    if (operation.method === "GET") {
        const query: string[] = [];
        for (const [key, value] of Object.entries(input))
            if (value !== undefined)
                query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        if (query.length)
            path += `?${query.join("&")}`;
        return { path, method: operation.method };
    }
    return { path, method: operation.method, body: input };
}
