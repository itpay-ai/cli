// UX handoff contract tests (W6): the two-goal interaction/communication
// plane, placeholder-free continuations, staged auth sessions with exact
// resume, the deterministic presentation resolver, secure browser URL
// admission, and relay gating.

import { execFileSync } from "node:child_process";
import { shellArgument, plainValueLines } from "../src/commands/guidance.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HttpClient } from "../src/client/http.js";
import { BackendClient } from "../src/client/backend.js";
import { agentAuth, sellerAuthPath } from "../src/state/account_auth.js";
import { TaskJournal } from "../src/state/task_journal.js";
import { isPresentableURL } from "../src/render/browser.js";
import { resolvePresentation, resolveRelay } from "../src/commands/presentation.js";
import { runServicesNext, runServicesStart } from "../src/commands/services.js";
import type { OutputSink } from "../src/render/sink.js";
import { startMockBackend, type MockBackendHandle } from "./mock_backend.js";

let mock: MockBackendHandle;
let backend: BackendClient;
let stdoutCapture: string[];
let stdoutSink: OutputSink;
let home: string;
let env: NodeJS.ProcessEnv;

before(async () => {
  mock = await startMockBackend();
  backend = new BackendClient(new HttpClient({ baseURL: mock.url }));
});

beforeEach(() => {
  mock.requests.length = 0;
  mock.setAgentBinding({ status: "unbound" });
  mock.setAuthSessionStage("waiting_provider");
  mock.setAuthSessionError(undefined);
  stdoutCapture = [];
  stdoutSink = (line) => { stdoutCapture.push(line); };
  home = mkdtempSync(join(tmpdir(), "itpay-ux-"));
  env = { HOME: home, ITPAY_TASK_JOURNAL_PATH: join(home, "task-journal.json") };
});

after(async () => {
  if (mock) await mock.close();
});

const allYes = {
  user_visible_browser: "yes", system_browser: "yes", clickable_https: "yes",
  image_visible: "yes", user_visible_terminal: "yes", other_device_scan: "yes",
  native_url_button: "yes", send_message: "yes",
} as const;
const unpaid = { commerce_policy: "allowed", payment_state: "unpaid", quote_valid: true, amount_minor: 5000 } as const;

// --- presentation resolver -----------------------------------------------

test("presentation resolver checks business state before any display route", () => {
  for (const [payment_state, expected] of [["paid", "read_same_order"], ["refund_locked", "read_same_order"], ["unknown", "read_same_order"]] as const) {
    const decision = resolvePresentation({ business: { ...unpaid, payment_state }, viewer: "desktop", executor_locality: "same_device", capabilities: allYes });
    assert.equal(decision.blocker, expected);
    assert.equal(decision.recommended, "none");
  }
  assert.equal(resolvePresentation({ business: { ...unpaid, quote_valid: false }, viewer: "desktop", executor_locality: "same_device", capabilities: allYes }).blocker, "recover_expired_quote");
  assert.equal(resolvePresentation({ business: { ...unpaid, commerce_policy: "blocked" }, viewer: "desktop", executor_locality: "same_device", capabilities: allYes }).blocker, "policy_blocked");
  // An unknown amount is never a displayable price.
  const unknownAmount = resolvePresentation({ business: { commerce_policy: "allowed", payment_state: "unpaid", quote_valid: true }, viewer: "desktop", executor_locality: "same_device", capabilities: allYes });
  assert.equal(unknownAmount.blocker, "read_same_order");
});

test("presentation resolver: desktop prefers embedded browser, mobile never gets a QR, max 1+2", () => {
  const desktop = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "same_device", capabilities: allYes });
  assert.equal(desktop.recommended, "open_embedded_browser");
  assert.ok(desktop.alternatives.length <= 2);
  const mobile = resolvePresentation({ business: unpaid, viewer: "mobile", executor_locality: "same_device", capabilities: allYes });
  assert.equal(mobile.recommended, "show_mobile_button");
  assert.ok(!mobile.routes.includes("show_terminal_qr"));
  // A remote executor cannot open the human's local browser.
  const remote = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "remote", capabilities: allYes });
  assert.ok(!remote.routes.includes("open_system_browser"));
});

test("presentation resolver never silently retries a failed route and honors an explicit feasible choice", () => {
  const once = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "same_device", capabilities: allYes });
  assert.equal(once.recommended, "open_embedded_browser");
  const again = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "same_device", capabilities: allYes, failed_routes: ["open_embedded_browser"] });
  assert.notEqual(again.recommended, "open_embedded_browser");
  const explicit = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "same_device", capabilities: allYes, explicit_choice: "show_official_image" });
  assert.equal(explicit.recommended, "show_official_image");
  // An explicit choice that is not feasible is not honored.
  const infeasible = resolvePresentation({ business: unpaid, viewer: "mobile", executor_locality: "same_device", capabilities: allYes, explicit_choice: "open_embedded_browser" });
  assert.notEqual(infeasible.recommended, "open_embedded_browser");
});

test("unknown capability answers never count as yes", () => {
  const allUnknown = {
    user_visible_browser: "unknown", system_browser: "unknown", clickable_https: "unknown",
    image_visible: "unknown", user_visible_terminal: "unknown", other_device_scan: "unknown",
    native_url_button: "unknown", send_message: "unknown",
  } as const;
  const decision = resolvePresentation({ business: unpaid, viewer: "desktop", executor_locality: "same_device", capabilities: allUnknown });
  assert.equal(decision.recommended, "show_copyable_entry");
});

// --- relay gating ----------------------------------------------------------

test("relay is unavailable without a backend capability and requires an issued option, key and consent", () => {
  assert.equal(resolveRelay({}).kind, "unavailable");
  assert.equal(resolveRelay({ backendCapability: true }).kind, "invalid");
  assert.equal(resolveRelay({ backendCapability: true, relayOption: "re_foo" }).kind, "invalid");
  assert.equal(resolveRelay({ backendCapability: true, relayOption: "re_foo", requestKey: "k1" }).kind, "needs_consent");
});

// --- browser URL admission -------------------------------------------------

test("browser opener only accepts https official origins (loopback only via explicit dev override)", () => {
  assert.equal(isPresentableURL("https://app.itpay.ai/checkout/chk_1", "https://app.itpay.ai", {}), true);
  assert.equal(isPresentableURL("https://sandbox.itpay.ai/x", "https://app.itpay.ai", {}), true);
  assert.equal(isPresentableURL("http://app.itpay.ai/x", "https://app.itpay.ai", {}), false);
  assert.equal(isPresentableURL("file:///etc/passwd", "https://app.itpay.ai", {}), false);
  assert.equal(isPresentableURL("itpay://pay", "https://app.itpay.ai", {}), false);
  assert.equal(isPresentableURL("https://evil.example.com/x", "https://app.itpay.ai", {}), false);
  assert.equal(isPresentableURL("javascript:alert(1)", "https://app.itpay.ai", {}), false);
  // Loopback is a dev-only escape, never default.
  assert.equal(isPresentableURL("http://127.0.0.1:8080/x", "http://127.0.0.1:8080", {}), false);
  assert.equal(isPresentableURL("http://127.0.0.1:8080/x", "http://127.0.0.1:8080", { ITPAY_CLI_DEV: "1" }), true);
});

// --- staged auth sessions (AUTH01/02/03/07) ---------------------------------

function seedOpenAuthSession(sessionID = "dash_mock"): void {
  const path = sellerAuthPath(mock.url, env, "agent-login");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    baseURL: mock.url,
    sessionID,
    pollToken: "poll_tok_mock",
    startToken: "start_tok_mock",
    authURL: `${mock.url}/auth?start_token=start_tok_mock&state=${sessionID}`,
  }));
}

test("AUTH01: distinct pending stages are reported, never compressed into generic pending", async () => {
  seedOpenAuthSession();
  mock.setAuthSessionStage("email_verification_required");
  const envelope = await agentAuth("status", mock.url, backend, env) as { status: string; result: Record<string, unknown>; instruction: string };
  assert.equal(envelope.status, "auth_pending");
  assert.equal(envelope.result.stage, "email_verification_required");
  assert.match(envelope.instruction, /联系方式验证/);

  mock.setAuthSessionStage("merge_confirmation_required");
  const merged = await agentAuth("status", mock.url, backend, env) as { status: string; result: Record<string, unknown>; instruction: string };
  assert.equal(merged.status, "auth_pending");
  assert.equal(merged.result.stage, "merge_confirmation_required");
  assert.match(merged.instruction, /账号合并/);
});

test("AUTH02: a completed open session binds in place instead of creating a new auth request", async () => {
  seedOpenAuthSession();
  mock.setAuthSessionStage("completed");
  const envelope = await agentAuth("login", mock.url, backend, env) as { status: string; result: Record<string, unknown> };
  assert.equal(envelope.status, "authenticated");
  assert.equal(envelope.result.bound, true);
  assert.equal(envelope.result.phone_verified, true);
  // The same session was bound — no fresh POST to create another session.
  assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/v1/dashboard/auth-sessions").length, 0);
  assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/v1/agent-device-account-bindings").length, 1);
});

test("AUTH03: a transport failure keeps the saved session and reports unknown, never a new request or a denial", async () => {
  seedOpenAuthSession();
  mock.setAuthSessionError("transport");
  const envelope = await agentAuth("status", mock.url, backend, env) as { status: string; instruction: string };
  assert.equal(envelope.status, "auth_status_unknown");
  assert.match(envelope.instruction, /不要新建授权/);
  // The open session survived the failed read.
  assert.equal(existsSync(sellerAuthPath(mock.url, env, "agent-login")), true);
  // And login on the same machine does not mint a second auth session either.
  const login = await agentAuth("login", mock.url, backend, env) as { status: string };
  assert.equal(login.status, "auth_status_unknown");
  assert.equal(mock.requests.filter((r) => r.method === "POST" && r.path === "/v1/dashboard/auth-sessions").length, 0);
});

test("AUTH07: a server-side missing session and a bare status are their own truthful states", async () => {
  seedOpenAuthSession("dash_gone");
  const gone = await agentAuth("status", mock.url, backend, env) as { status: string; next?: { command: string } | null };
  assert.equal(gone.status, "auth_session_missing");
  assert.equal(gone.next?.command, "itpay auth login --json");

  const bare = await agentAuth("status", mock.url, backend, env) as { status: string };
  assert.equal(bare.status, "login_required");
});

test("AUTH07: terminal auth states are distinct and do not pretend to be pending", async () => {
  seedOpenAuthSession();
  mock.setAuthSessionStage("cancelled");
  const cancelled = await agentAuth("status", mock.url, backend, env) as { status: string };
  assert.equal(cancelled.status, "auth_cancelled");
  assert.equal(existsSync(sellerAuthPath(mock.url, env, "agent-login")), false);
});

test("AUTH04: a successful bind resumes the exact journaled task — no placeholders", async () => {
  const journal = new TaskJournal(env.ITPAY_TASK_JOURNAL_PATH!);
  journal.record({
    service_execution_id: "se_paused_login",
    service_id: "itpay-rail-smart",
    stage: "login_required",
    resume_command: "itpay services run itpay-rail-smart --execution se_paused_login --json",
  });
  mock.setAgentBinding({ status: "authenticated", phone_verified: true });
  const envelope = await agentAuth("status", mock.url, backend, env) as { status: string; next?: { command: string } | null };
  assert.equal(envelope.status, "authenticated");
  assert.equal(envelope.next?.command, "itpay services run itpay-rail-smart --execution se_paused_login --json");
  assert.doesNotMatch(envelope.next?.command ?? "", /</);
});

test("AUTH04: without a journaled task the envelope says so instead of emitting a placeholder", async () => {
  mock.setAgentBinding({ status: "authenticated", phone_verified: true });
  const envelope = await agentAuth("status", mock.url, backend, env) as { status: string; next?: { command: string } | null; instruction: string };
  assert.equal(envelope.status, "authenticated");
  assert.equal(envelope.next, null);
  assert.match(envelope.instruction, /没有待恢复/);
});

// --- two-goal interaction + envelope shape ----------------------------------

test("rail planning in-progress envelope carries a communication plane", async () => {
  await runServicesNext(backend, "se_rail_plan_running", { jsonOutput: true, output: stdoutSink, env });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    next: { command: string } | null;
    communication?: { status_line?: string; next_expectation?: string };
  };
  assert.equal(envelope.status, "planning");
  assert.equal(envelope.communication, undefined);
  assert.match(envelope.next?.command ?? "", /--timeout 120/);
  assert.match(envelope.next?.command ?? "", /services next se_rail_plan_running/);
});

test("rail planning ready envelope carries two-goal interaction, communication and no fake executable next", async () => {
  await runServicesNext(backend, "se_rail_plan_complete", { jsonOutput: true, output: stdoutSink, env });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    instruction: string;
    next: { command: string } | null;
    interaction?: { schema_version?: string; stage?: string; by_goal?: Record<string, unknown>; recipe?: unknown; input_template?: unknown };
    communication?: { status_line?: string; must_convey?: string[] };
    recovery: unknown[];
  };
  assert.equal(envelope.interaction, undefined);
  assert.equal(envelope.communication, undefined);
  assert.doesNotMatch(stdoutCapture.join(""), /by_goal|interaction.recipe|rail.selected-to-checkout/);
  // No unresolved placeholder is ever presented as an executable command.
  const rendered = JSON.stringify(envelope);
  assert.doesNotMatch(envelope.next?.command ?? "", /</);
  // The envelope contract stays complete.
  assert.ok(envelope.status && envelope.instruction && Array.isArray(envelope.recovery));
  assert.ok(rendered.length > 0);
});

test("generic service start uses input_template, never an executable placeholder command", async () => {
  const base = await backend.getServiceExecution("se_rail_plan_running");
  const model = { ...base, workflow_entry: { capability_id: "itpay_service", input_schema: { type: "object" } } };
  const client = Object.create(backend) as BackendClient;
  client.startServiceExecution = async () => ({
    execution: { ...model.execution, service_id: "itpay-rail-smart" },
    capabilities: model.capabilities,
    workflow_entry: model.workflow_entry,
  });
  await runServicesStart(client, "itpay-rail-smart", { jsonOutput: true, output: stdoutSink, env });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    next: { command: string } | null;
    interaction?: { input_template?: { command: string; required_input?: string[]; executable?: boolean } | Array<{ command: string; required_input?: string[]; executable?: boolean }> };
  };
  assert.equal(envelope.status, "input_required");
  if (envelope.next) assert.doesNotMatch(envelope.next.command, /<[a-z_]+>/);
  const templates = Array.isArray(envelope.interaction?.input_template)
    ? envelope.interaction?.input_template
    : envelope.interaction?.input_template ? [envelope.interaction.input_template] : [];
  assert.ok(templates.length > 0);
  for (const template of templates) {
    // A command containing unresolved slots is never executable and names them.
    if (/<[a-z_]+>/.test(template.command)) {
      assert.equal(template.executable, false);
      assert.ok((template.required_input ?? []).length > 0);
    }
  }
});

// --- task journal ------------------------------------------------------------

test("task journal keeps paused tasks resumable and forgets terminal ones", () => {
  const journal = new TaskJournal(env.ITPAY_TASK_JOURNAL_PATH!);
  journal.record({ service_execution_id: "se_a", stage: "login_required", resume_command: "itpay services run svc --execution se_a --json" });
  journal.record({ service_execution_id: "se_b", stage: "login_required" });
  journal.observe("se_b", "completed");
  const paused = journal.pausedTasks();
  assert.equal(paused.length, 1);
  assert.equal(paused[0]!.service_execution_id, "se_a");
  assert.equal(paused[0]!.resume_command, "itpay services run svc --execution se_a --json");
});

test("post-v3 shell arguments preserve literal user text and plain objects stay readable", () => {
 for (const value of ["有 空格", "a'b", '"quote"', '$(printf unsafe)', '`printf unsafe`']) {
  assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellArgument(value)}`], {encoding:"utf8"}), value);
 }
 const text = plainValueLines({rides:[{train_code:"G1",departure:"2026-10-08 09:00"}],detail:{command:"itpay services page se ri --limit 1 --json"}}).join("\n");
 assert.match(text,/train_code: G1/); assert.match(text,/command: itpay services page/); assert.doesNotMatch(text,/\{\"/);
});
