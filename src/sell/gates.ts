// Human approval gates for the Seller publishing flow.
//
// Six publishing decisions (G1..G6) must each be explicitly approved by a
// human before the corresponding platform mutation can run. An approval is a
// ledger entry bound to a fingerprint of the EXACT content being approved
// (request payload, AI candidate hash, or passed validation evidence), so any
// change after review invalidates the approval and forces the human to review
// again. Approvals are single-use: the entry is consumed when the gated
// operation succeeds.
//
// Agents (CLI or MCP) cannot satisfy a gate themselves: in a non-interactive
// context `gates approve` requires a --note recording the human's decision;
// the ITPAY_SELL_SKIP_GATES escape hatch is refused against production.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_BASE_URL, resolveBackendURL, type CLIConfig } from "../state/config.js";
import type { BackendClient } from "../client/backend.js";

export type GateId = "g1" | "g2" | "g3" | "g4" | "g5" | "g6";

export const GATE_META: Record<GateId, { title: string; decision: string }> = {
    g1: { title: "Service identity", decision: "确认服务身份：Service ID 与公开名称（线上唯一、不得误导/重名）" },
    g2: { title: "API source & credential responsibility", decision: "确认 API 来源与凭证责任：BYOK 自有 Key 或 ItPay 托管 Key" },
    g3: { title: "Workflow plan & fixtures", decision: "审阅 AI 编排方案（节点/连线/YAML/校验）与测试 fixtures，确认后才落盘版本" },
    g4: { title: "Platform E2E evidence", decision: "审阅平台真实验证结果（通过率/安全检查/副作用）并接受证据" },
    g5: { title: "Pricing & refund policy", decision: "确认计费模式、金额、币种与退款政策" },
    g6: { title: "Terms & submission", decision: "确认三项服务条款并提交审核（提交 ≠ 发布，仍需平台 Admin 审批）" },
};

// command (as named in the sell contract) -> gate
export const GATED_COMMANDS: Record<string, { gate: GateId; purpose?: GatePurpose }> = {
    "services create": { gate: "g1" },
    "sources import": { gate: "g2", purpose: "import" },
    "sources library": { gate: "g2", purpose: "library" },
    "workflow plan-apply": { gate: "g3", purpose: "apply" },
    "fixtures set": { gate: "g3", purpose: "fixtures" },
    "workflow versions save-platform": { gate: "g3", purpose: "version" },
    "pricing set": { gate: "g5" },
    "submission submit": { gate: "g6" },
};

export type GatePurpose = "import" | "library" | "apply" | "fixtures" | "version";

export interface GateEntry {
    gate: GateId;
    purpose?: GatePurpose | undefined;
    merchant_id: string;
    draft_id?: string | undefined;
    fingerprint: string;
    summary: Record<string, unknown>;
    note?: string | undefined;
    non_interactive: boolean;
    approved_at: string;
    consumed_at?: string | undefined;
    bypassed?: boolean | undefined;
}

interface Ledger {
    version: 1;
    entries: GateEntry[];
    bypasses: { at: string; command: string; gate: GateId; merchant_id?: string | null | undefined; draft_id?: string | null | undefined }[];
}

export interface GateReceipt {
    gate: GateId;
    purpose?: GatePurpose | undefined;
    fingerprint: string;
    bypassed: boolean;
}

export interface GateBlock {
    status: "gate_required";
    operation: string;
    gate: GateId;
    purpose?: GatePurpose | undefined;
    title: string;
    human_decision: string;
    review: Record<string, unknown>;
    fingerprint: string;
    approve_command: string;
    instruction: string;
}

export class GateRequiredError extends Error {
    constructor(readonly block: GateBlock) {
        super(JSON.stringify(block));
        this.name = "GateRequiredError";
    }
}

export interface EnforceArgs {
    command: string;
    merchantId?: string | null | undefined;
    draftId?: string | null | undefined;
    runId?: string | null | undefined;
    input: Record<string, unknown>;
    request: { path: string; method: string; body?: unknown };
    backend: BackendClient;
    config: CLIConfig;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

function sha256(value: string): string {
    return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
}

function payloadFingerprint(gate: GateId, purpose: string | undefined, body: unknown): string {
    return `itpay-sell-gate.v1:${gate}${purpose ? ":" + purpose : ""}:` + sha256(canonical(body ?? {}));
}

// ---------------------------------------------------------------------------
// Ledger persistence
// ---------------------------------------------------------------------------

const SANDBOX_VALUE = "https://sandbox.itpay.ai";

function ledgerFilename(env: NodeJS.ProcessEnv): string {
    if (resolveBackendURL(env) !== SANDBOX_VALUE) return "sell-gates.json";
    return "sell-gates.sandbox.json";
}

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
    const dir = resolve(env.HOME || homedir(), ".itpay-v3");
    mkdirSync(dir, { recursive: true });
    return resolve(dir, ledgerFilename(env));
}

function loadLedger(env: NodeJS.ProcessEnv): Ledger {
    const path = ledgerPath(env);
    if (!existsSync(path)) return { version: 1, entries: [], bypasses: [] };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger>;
        return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [], bypasses: Array.isArray(parsed.bypasses) ? parsed.bypasses : [] };
    }
    catch {
        return { version: 1, entries: [], bypasses: [] };
    }
}

function saveLedger(ledger: Ledger, env: NodeJS.ProcessEnv): void {
    const path = ledgerPath(env);
    writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function findOpenEntry(ledger: Ledger, gate: GateId, merchantId: string, draftId: string | null | undefined, purpose: GatePurpose | undefined, fingerprint: string): GateEntry | undefined {
    return ledger.entries.find((entry) =>
        entry.gate === gate
        && entry.merchant_id === merchantId
        && (entry.draft_id ?? "") === (draftId ?? "")
        && (entry.purpose ?? "") === (purpose ?? "")
        && entry.fingerprint === fingerprint
        && !entry.consumed_at
        && !entry.bypassed);
}

function hasEntry(ledger: Ledger, gate: GateId, merchantId: string, draftId?: string): boolean {
    return ledger.entries.some((entry) =>
        entry.gate === gate
        && entry.merchant_id === merchantId
        && (draftId === undefined || (entry.draft_id ?? "") === draftId)
        && !entry.bypassed);
}

// ---------------------------------------------------------------------------
// Review summaries
// ---------------------------------------------------------------------------

function preview(value: unknown, max = 1200): unknown {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text === "string" && text.length > max) return text.slice(0, max) + `…(${text.length} chars total)`;
    return value;
}

function bodySummary(gate: GateId, body: Record<string, unknown>): Record<string, unknown> {
    if (gate === "g1") return { service_id: body.service_id, public_name: body.public_name };
    if (gate === "g5") return { expected_revision: body.expected_revision, pricing: body.pricing, policy: body.policy };
    if (gate === "g6") {
        return {
            expected_revision: body.expected_revision,
            terms_version: body.terms_version,
            confirmations: body.confirmations,
        };
    }
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, preview(value)]));
}

function runSummary(run: Record<string, unknown>): Record<string, unknown> {
    return {
        orchestration_run_id: run.orchestration_run_id,
        status: run.status,
        instruction: run.instruction,
        base_semantic_revision: run.base_semantic_revision,
        candidate_hash: run.candidate_hash,
        candidate_nodes: Array.isArray(run.candidate_nodes) ? run.candidate_nodes.length : 0,
        candidate_edges: Array.isArray(run.candidate_edges) ? run.candidate_edges.length : 0,
        validation: run.validation,
        inspect_with: "itpay sell workflow plan-get --run-id <id> --json",
    };
}

function evidenceSummary(run: Record<string, unknown>): Record<string, unknown> {
    return {
        validation_run_id: run.validation_run_id,
        workflow_version_id: run.workflow_version_id,
        status: run.status,
        semantic_revision: run.semantic_revision,
        semantic_hash: run.semantic_hash,
        fixture_revision: run.fixture_revision,
        fixture_hash: run.fixture_hash,
        metrics: run.metrics,
        side_effect_operations: run.side_effect_operations,
        issues: run.issues,
        inspect_with: "itpay sell runs get --run-id <id> --json",
    };
}

// ---------------------------------------------------------------------------
// Fingerprint derivation (fetches server-side content where content binding
// cannot be inferred from the request body alone)
// ---------------------------------------------------------------------------

type Derived = { fingerprint: string; review: Record<string, unknown>; merchantId: string; draftId?: string | null | undefined };

async function deriveFingerprint(args: EnforceArgs, spec: { gate: GateId; purpose?: GatePurpose }): Promise<Derived> {
    const body = (args.request.body ?? {}) as Record<string, unknown>;
    const merchantId = args.merchantId ?? "";
    const draftId = args.draftId;
    if (!merchantId) throw new Error("merchant_id is required for gate enforcement");

    if (spec.gate === "g3" && spec.purpose === "apply") {
        if (!draftId) throw new Error("draft_id is required");
        if (!args.runId) throw new Error("run_id is required");
        const run = await args.backend.sellRequest({
            method: "GET",
            path: `/v1/seller/organizations/${encodeURIComponent(merchantId)}/service-drafts/${encodeURIComponent(draftId)}/orchestration-runs/${encodeURIComponent(args.runId)}`,
        }) as Record<string, unknown>;
        const status = String(run.status ?? "");
        const validation = run.validation as { valid?: boolean } | undefined;
        if (!["completed", "applied"].includes(status) || !validation?.valid)
            throw new Error(`Orchestration run ${args.runId} is not an approved candidate (status=${status}, validation.valid=${validation?.valid ?? false})`);
        const fingerprint = payloadFingerprint("g3", "apply", {
            orchestration_run_id: run.orchestration_run_id,
            candidate_hash: run.candidate_hash,
            expected_revision: body.expected_revision,
        });
        return { fingerprint, review: runSummary(run), merchantId, draftId };
    }

    return {
        fingerprint: payloadFingerprint(spec.gate, spec.purpose, body),
        review: bodySummary(spec.gate, body),
        merchantId,
        draftId,
    };
}

function approveCommand(gate: GateId, merchantId: string, draftId: string | null | undefined, purpose: GatePurpose | undefined, runId: string | null | undefined): string {
    const parts = ["itpay sell gates approve", `--gate ${gate}`, `--merchant-id ${merchantId}`];
    if (draftId) parts.push(`--draft-id ${draftId}`);
    if (purpose) parts.push(`--purpose ${purpose}`);
    if (runId) parts.push(`--run-id ${runId}`);
    if (gate === "g1" || gate === "g2" || gate === "g5" || gate === "g6" || (gate === "g3" && purpose !== "apply"))
        parts.push("--input-json <same payload file>");
    parts.push('--note "<human decision in their own words>"');
    return parts.join(" ");
}

function gatesBypassed(config: CLIConfig, env: NodeJS.ProcessEnv): boolean {
    return env.ITPAY_SELL_SKIP_GATES === "1" && config.baseURL !== DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Enforcement (called by both the commander CLI and the MCP server)
// ---------------------------------------------------------------------------

export async function enforcePlatformGate(args: EnforceArgs, env: NodeJS.ProcessEnv = process.env): Promise<GateReceipt | undefined> {
    const spec = GATED_COMMANDS[args.command];
    if (!spec) return undefined;

    if (env.ITPAY_SELL_SKIP_GATES === "1" && args.config.baseURL === DEFAULT_BASE_URL)
        throw new Error("ITPAY_SELL_SKIP_GATES is forbidden against production");
    if (gatesBypassed(args.config, env)) {
        const ledger = loadLedger(env);
        ledger.bypasses.push({
            at: new Date().toISOString(),
            command: args.command,
            gate: spec.gate,
            merchant_id: args.merchantId,
            draft_id: args.draftId,
        });
        saveLedger(ledger, env);
        process.stderr.write(`[itpay] WARNING: seller gate ${spec.gate} (${GATE_META[spec.gate].title}) BYPASSED via ITPAY_SELL_SKIP_GATES for "${args.command}".\n`);
        return { gate: spec.gate, purpose: spec.purpose, fingerprint: "", bypassed: true };
    }

    const derived = await deriveFingerprint(args, spec);
    const ledger = loadLedger(env);
    const entry = findOpenEntry(ledger, spec.gate, derived.merchantId, derived.draftId, spec.purpose, derived.fingerprint);
    if (!entry) {
        const meta = GATE_META[spec.gate];
        throw new GateRequiredError({
            status: "gate_required",
            operation: args.command,
            gate: spec.gate,
            purpose: spec.purpose,
            title: meta.title,
            human_decision: meta.decision,
            review: derived.review,
            fingerprint: derived.fingerprint,
            approve_command: approveCommand(spec.gate, derived.merchantId, derived.draftId, spec.purpose, args.runId),
            instruction: "停止自动执行：把 review 内容完整展示给用户并等待明确同意；用户同意后由其本人或在其指示下执行 approve_command，然后重试本操作。agent 不得自行批准。",
        });
    }
    return { gate: spec.gate, purpose: spec.purpose, fingerprint: derived.fingerprint, bypassed: false };
}

export function consumePlatformGate(receipt: GateReceipt, args: { merchantId?: string | null | undefined; draftId?: string | null | undefined }, env: NodeJS.ProcessEnv = process.env): void {
    if (receipt.bypassed || !receipt.fingerprint) return;
    try {
        const ledger = loadLedger(env);
        const entry = ledger.entries.find((candidate) =>
            candidate.gate === receipt.gate
            && (candidate.purpose ?? "") === (receipt.purpose ?? "")
            && candidate.merchant_id === (args.merchantId ?? "")
            && (candidate.draft_id ?? "") === (args.draftId ?? "")
            && candidate.fingerprint === receipt.fingerprint
            && !candidate.consumed_at);
        if (entry) {
            entry.consumed_at = new Date().toISOString();
            saveLedger(ledger, env);
        }
    }
    catch (error) {
        process.stderr.write(`[itpay] gate receipt could not be consumed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    }
}

// ---------------------------------------------------------------------------
// Approval recording (`itpay sell gates approve`)
// ---------------------------------------------------------------------------

export interface ApprovalArgs {
    gate: GateId;
    merchantId: string;
    draftId?: string | undefined;
    purpose?: GatePurpose | undefined;
    runId?: string | undefined;
    expectedRevision?: number | undefined;
    input?: Record<string, unknown>;
    note?: string;
    nonInteractive: boolean;
    confirmed: boolean; // interactive prompt answered APPROVE
    backend: BackendClient;
}

export async function recordApproval(args: ApprovalArgs, env: NodeJS.ProcessEnv = process.env): Promise<{ entry: GateEntry; review: Record<string, unknown> }> {
    const ledger = loadLedger(env);
    let fingerprint: string;
    let review: Record<string, unknown>;
    let draftId = args.draftId;
    let purpose = args.purpose;

    if (args.gate === "g3" && (purpose === "apply" || (!purpose && args.runId))) {
        purpose = "apply";
        if (!draftId || !args.runId) throw new Error("g3 apply approval requires --draft-id and --run-id");
        const run = await args.backend.sellRequest({
            method: "GET",
            path: `/v1/seller/organizations/${encodeURIComponent(args.merchantId)}/service-drafts/${encodeURIComponent(draftId)}/orchestration-runs/${encodeURIComponent(args.runId)}`,
        }) as Record<string, unknown>;
        const status = String(run.status ?? "");
        const validation = run.validation as { valid?: boolean } | undefined;
        if (!["completed", "applied"].includes(status) || !validation?.valid)
            throw new Error(`Orchestration run ${args.runId} is not a valid completed candidate (status=${status}, validation.valid=${validation?.valid ?? false})`);
        fingerprint = payloadFingerprint("g3", "apply", {
            orchestration_run_id: run.orchestration_run_id,
            candidate_hash: run.candidate_hash,
            expected_revision: args.expectedRevision,
        });
        review = runSummary(run);
    }
    else if (args.gate === "g4") {
        if (!draftId || !args.runId) throw new Error("g4 approval requires --draft-id and --run-id of the validation run");
        const run = await args.backend.sellRequest({
            method: "GET",
            path: `/v1/seller/organizations/${encodeURIComponent(args.merchantId)}/service-drafts/${encodeURIComponent(draftId)}/validation-runs/${encodeURIComponent(args.runId)}`,
        }) as Record<string, unknown>;
        if (run.status !== "passed")
            throw new Error(`Validation run ${args.runId} status is "${run.status ?? "unknown"}"; only passed evidence can be accepted (G4)`);
        fingerprint = payloadFingerprint("g4", undefined, {
            validation_run_id: run.validation_run_id,
            workflow_version_id: run.workflow_version_id,
            semantic_hash: run.semantic_hash,
            fixture_hash: run.fixture_hash,
            semantic_revision: run.semantic_revision,
        });
        review = evidenceSummary(run);
    }
    else {
        if (!args.input) throw new Error(`--input-json with the exact reviewed payload is required for gate ${args.gate}`);
        if (args.gate === "g3" && !purpose) {
            if ("arazzo_document" in args.input) purpose = "version";
            else if ("fixtures" in args.input) purpose = "fixtures";
            else throw new Error("g3 payload approval requires --purpose apply|fixtures|version");
        }
        if (args.gate === "g2" && !purpose)
            purpose = "library_api_id" in args.input ? "library" : "import";
        fingerprint = payloadFingerprint(args.gate, purpose, args.input);
        review = bodySummary(args.gate, args.input);
    }

    // Chain: previous human decision must exist before a later gate can be recorded.
    const chain: [GateId, () => boolean][] = [
        ["g2", () => args.gate !== "g3" || hasEntry(ledger, "g1", args.merchantId, draftId) && hasEntry(ledger, "g2", args.merchantId)],
        ["g3", () => args.gate !== "g4" || hasEntry(ledger, "g3", args.merchantId, draftId)],
        ["g4", () => args.gate !== "g5" || hasEntry(ledger, "g4", args.merchantId, draftId)],
        ["g5", () => args.gate !== "g6" || hasEntry(ledger, "g5", args.merchantId, draftId)],
    ];
    for (const [required, ok] of chain)
        if (!ok()) throw new Error(`Gate ${args.gate} requires an earlier human decision at ${required.toUpperCase()} for this draft. Review and approve ${required.toUpperCase()} first.`);

    if (args.nonInteractive && !(args.note ?? "").trim())
        throw new Error("Non-interactive approval requires --note recording the human's decision. Ask the human and quote their reply.");
    if (!args.nonInteractive && !args.confirmed)
        throw new Error("Interactive approval must be confirmed by typing APPROVE");

    const existing = ledger.entries.find((entry) =>
        entry.gate === args.gate
        && entry.merchant_id === args.merchantId
        && (entry.draft_id ?? "") === (draftId ?? "")
        && (entry.purpose ?? "") === (purpose ?? "")
        && entry.fingerprint === fingerprint);
    const entry: GateEntry = existing ?? {
        gate: args.gate,
        merchant_id: args.merchantId,
        fingerprint,
        non_interactive: args.nonInteractive,
        approved_at: new Date().toISOString(),
        summary: review,
    };
    entry.purpose = purpose;
    entry.draft_id = draftId;
    entry.note = args.note?.trim() || entry.note;
    entry.consumed_at = undefined; // re-approval re-opens a consumed entry
    if (!existing) ledger.entries.push(entry);
    saveLedger(ledger, env);
    return { entry, review };
}

export function listEntries(filter: { merchantId?: string | undefined; draftId?: string | undefined }, env: NodeJS.ProcessEnv = process.env): Ledger {
    const ledger = loadLedger(env);
    return {
        ...ledger,
        entries: ledger.entries.filter((entry) =>
            (!filter.merchantId || entry.merchant_id === filter.merchantId)
            && (filter.draftId === undefined || (entry.draft_id ?? "") === filter.draftId)),
    };
}
