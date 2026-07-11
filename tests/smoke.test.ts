// Smoke test for the V3 CLI. Runs against a minimal in-process mock
// that mirrors the V3 DTO contracts. Covers:
//   - cart session add/remove/show
//   - client context (host/target) validation
//   - buy dispatch for terminal / markdown / telegram / feishu / plain_chat
//   - per-command smoke (readyz, checkout, pay, order, orders, refund)
//
// DTO contracts mirror services/backend/internal/presenter/*.go.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HttpClient, HttpError } from "../src/client/http.js";
import { BackendClient } from "../src/client/backend.js";
import { CartSession } from "../src/state/cart_session.js";
import {
  HOSTS_REQUIRING_TARGET,
  defaultHostForAgentType,
  normalizeHost,
  validateContext,
} from "../src/state/client_context.js";
import { runBuy, buildCheckoutQRPlan, buildJSONOutput } from "../src/commands/buy.js";
import { buildServiceInvokedGuidance, buildServiceReadModelGuidance, errorRecoveryActions } from "../src/commands/guidance.js";
import { runReadyz } from "../src/commands/readyz.js";
import { runCheckoutPresentation } from "../src/commands/checkout.js";
import { runPay } from "../src/commands/pay.js";
import { runOrder } from "../src/commands/order.js";
import { runListOrders } from "../src/commands/orders.js";
import { runRefund } from "../src/commands/refund.js";
import { runCartAdd, runCartShow, runCartRemove, runCartClear, runCartRemoveServer, runCartAbandonServer, runCartAddServer, runCartNext } from "../src/commands/cart.js";
import { runCatalogList } from "../src/commands/catalog.js";
import { runServicesAction, runServicesCheckout, runServicesInvoke, runServicesList, runServicesNext, runServicesReadResult } from "../src/commands/services.js";
import { dispatchInteractionRequest } from "../src/render/interaction.js";
import { DEFAULT_BASE_URL, type CLIConfig } from "../src/state/config.js";
import type { OutputSink } from "../src/render/sink.js";
import { startMockBackend, type MockBackendHandle } from "./mock_backend.js";
import { extractInputRequestFromMarkdown, submitAgentInputRequest } from "./mock_agent_adapter.js";

const execFileAsync = promisify(execFile);
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = resolve(CLI_ROOT, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(CLI_ROOT, "src/main.ts");

let mock: MockBackendHandle;
let config: CLIConfig;
let backend: BackendClient;
const silent: OutputSink = () => undefined;
let stdoutCapture: string[];
let stdoutSink: OutputSink;

async function runCLI(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

before(async () => {
  mock = await startMockBackend();
  config = {
    baseURL: mock.url,
    agentDeviceID: "agent_smoke",
    checkoutCurrency: "CNY",
    idempotencyKey: "cli_smoke_key",
    ideImageAttach: true,
  };
  backend = new BackendClient(new HttpClient({ baseURL: mock.url }));
});

beforeEach(() => {
  mock.requests.length = 0;
  stdoutCapture = [];
  stdoutSink = (line) => {
    stdoutCapture.push(line);
  };
});

after(async () => {
  if (mock) await mock.close();
});

// --- client context ------------------------------------------------------

test("production backend is the package default", () => {
  assert.equal(DEFAULT_BASE_URL, "https://app.itpay.ai");
});

test("normalizeHost handles aliases and rejects unknown hosts", () => {
  assert.equal(normalizeHost("telegram"), "telegram");
  assert.equal(normalizeHost("TG"), "telegram");
  assert.equal(normalizeHost("openclaw-telegram"), "telegram");
  assert.equal(normalizeHost("trae"), "codex");
  assert.equal(normalizeHost("trae-agent"), "codex");
  assert.equal(normalizeHost("feishu_im"), "feishu");
  assert.equal(normalizeHost("unknown"), undefined);
});

test("agent type selects the default client surface", () => {
  assert.equal(defaultHostForAgentType("codex-desktop"), "codex");
  assert.equal(defaultHostForAgentType("claude-code-cli"), "claude-code");
  assert.equal(defaultHostForAgentType("workbuddy"), "terminal");
});

test("validateContext enforces --target for IM hosts", () => {
  for (const host of HOSTS_REQUIRING_TARGET) {
    const err = validateContext(host, undefined);
    assert.ok(err, `expected target_required for ${host}`);
    assert.equal(err!.code, "target_required");
  }
  assert.equal(validateContext("terminal", undefined), undefined);
  assert.equal(validateContext("telegram", "chat-1"), undefined);
});

// --- cart session --------------------------------------------------------

test("cart add de-dupes by variant+offer and sums quantities", () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 2,
    output: silent,
  });
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 3,
    output: silent,
  });
  const snap = session.show();
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0]!.quantity, 5);
});

test("cart remove and clear mutate the session", () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  runCartRemove(session, { catalogVariantID: "v_1", offerID: "o_1", output: silent });
  assert.equal(session.show().items.length, 0);
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_2",
    offerID: "o_2",
    quantity: 1,
    output: silent,
  });
  runCartClear(session);
  assert.equal(session.show().items.length, 0);
});

test("server cart remove and abandon call canonical backend routes", async () => {
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_server_1", cartItemID: "cart_item_1" });
  await runCartRemoveServer(backend, session, undefined, { output: silent });
  assert.equal(mock.requests.at(-1)?.method, "DELETE");
  assert.equal(mock.requests.at(-1)?.path, "/v1/carts/cart_server_1/items/cart_item_1");

  await runCartAbandonServer(backend, session, { output: silent });
  assert.equal(mock.requests.at(-1)?.method, "DELETE");
  assert.equal(mock.requests.at(-1)?.path, "/v1/carts/cart_server_1");
  assert.equal(session.lastCartID, undefined);
});

test("server cart clear drops local handle when canonical cart is locked", async () => {
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_locked", cartItemID: "cart_item_locked" });
  const lockedBackend = {
    abandonCart: async () => {
      throw new HttpError(409, { code: "cart_item_locked", message: "cart item is locked" }, "HTTP 409");
    },
  } as unknown as BackendClient;

  await runCartAbandonServer(lockedBackend, session, { output: stdoutSink });

  assert.equal(session.lastCartID, undefined);
  assert.match(stdoutCapture.join(""), /server cart cart_locked is locked by quote\/checkout/);
});

test("server cart add returns service execution guidance for service-backed lines", async () => {
  const session = new CartSession("CNY");
  await runCartAddServer({
    catalogItemID: "cat_service",
    catalogVariantID: "var_service",
    offerID: "offer_service",
    quantity: 1,
    backend,
    config,
    session,
    host: "terminal",
    jsonOutput: true,
    output: stdoutSink,
  });
  const parsed = JSON.parse(stdoutCapture.join("")) as {
    items: Array<{ service_execution_id?: string }>;
    agent_guidance: { next_actions: Array<{ command: string }> };
  };
  assert.equal(parsed.items[0]!.service_execution_id, "se_mock_1");
  assert.ok(parsed.agent_guidance.next_actions.some((action) => action.command.includes("fuzzy_disambiguation")));
  assert.equal(session.lastServiceExecutionID, "se_mock_1");

  stdoutCapture = [];
  await runCartNext(backend, session, { jsonOutput: true, output: stdoutSink });
  const guidance = JSON.parse(stdoutCapture.join("")) as { next_actions: Array<{ command: string }> };
  assert.ok(guidance.next_actions.some((action) => action.command.includes("fuzzy_disambiguation")));
});

test("services next prints service execution guidance", async () => {
  await runServicesNext(backend, "se_mock_next", { jsonOutput: true, output: stdoutSink });
  const guidance = JSON.parse(stdoutCapture.join("")) as {
    next_actions: Array<{ command: string }>;
    state: { capabilities: Array<{ capability_id: string }> };
  };
  assert.ok(guidance.next_actions.some((action) => action.command.includes("fuzzy_disambiguation")));
  assert.ok(guidance.state.capabilities.some((capability) => capability.capability_id === "precise_lookup"));
});

test("quota exhaustion uses the backend-selected paid capability without guessing", () => {
  const response = {
    execution: {
      service_execution_id: "se_quota", service_id: "svc_company", service_contract_version_id: "scv_2",
      status: "quota_exhausted", phase: "pre_purchase", current_capability_id: "fuzzy_disambiguation",
      checkout_required: true, next_action: "create_checkout", started_at: "2026-07-11T00:00:00Z",
      created_at: "2026-07-11T00:00:00Z", updated_at: "2026-07-11T00:00:00Z",
    },
    invocation: { service_capability_invocation_id: "sci_1", service_execution_id: "se_quota", capability_id: "fuzzy_disambiguation", status: "quota_exhausted", created_at: "2026-07-11T00:00:00Z" },
    result_items: [], provider_called: false,
    effective_quota: { bucket: "company_lookup_fuzzy", subject_type: "device_lineage", limit: 3, remaining: 0, exhausted: true, replenishment: "purchase_finalized" },
    next_actions: [{ kind: "create_checkout", capability_id: "fuzzy_disambiguation_paid", requires_human: true }],
  };
  const guidance = buildServiceInvokedGuidance(response, [{
    capability_id: "fuzzy_disambiguation_paid", phase: "paid_fulfillment", agent_visible: true,
    requires_payment: true, requires_human_action: false, vault_required: false,
    delivery_email_required: false, price_amount_minor: 10, price_currency: "CNY",
  }]);
  assert.match(guidance.summary, /quota 0\/3/);
  assert.equal(guidance.next_actions[0]?.command, "itpay services checkout se_quota --capability fuzzy_disambiguation_paid --json");
  assert.match(guidance.next_actions[0]?.reason ?? "", /does not require a delivery email/);
});

test("protected checkout explains that email delivers the claim link", () => {
  const guidance = buildServiceInvokedGuidance({
    execution: {
      service_execution_id: "se_precise", service_id: "svc_company", service_contract_version_id: "scv_2",
      status: "quota_exhausted", phase: "pre_purchase", current_capability_id: "fuzzy_disambiguation",
      checkout_required: true, next_action: "create_checkout", started_at: "2026-07-11T00:00:00Z",
      created_at: "2026-07-11T00:00:00Z", updated_at: "2026-07-11T00:00:00Z",
    },
    result_items: [], provider_called: false,
    next_actions: [{ kind: "create_checkout", capability_id: "precise_report", requires_human: true }],
  }, [{
    capability_id: "precise_report", phase: "paid_fulfillment", agent_visible: false,
    requires_payment: true, requires_human_action: false, vault_required: true,
    delivery_email_required: true, price_amount_minor: 50, price_currency: "CNY",
  }]);
  assert.equal(guidance.next_actions[0]?.command, "itpay services checkout se_precise --capability precise_report --email <email> --json");
  assert.match(guidance.next_actions[0]?.reason ?? "", /claim link/);
  assert.match(guidance.next_actions[0]?.reason ?? "", /never invent/);
});

test("services invoke reads target capability metadata before checkout guidance", async () => {
  await runServicesInvoke(
    backend,
    config,
    "se_quota",
    "fuzzy_disambiguation",
    { keyword: "美团" },
    { jsonOutput: true, output: stdoutSink },
  );
  const parsed = JSON.parse(stdoutCapture.join("")) as {
    agent_guidance: { next_actions: Array<{ command: string; reason?: string }> };
  };
  assert.equal(
    parsed.agent_guidance.next_actions[0]?.command,
    "itpay services checkout se_quota --capability fuzzy_disambiguation_paid --json",
  );
  assert.match(parsed.agent_guidance.next_actions[0]?.reason ?? "", /does not require a delivery email/);
  const requests = mock.requests.filter((request) => request.path.includes("/v1/service-executions/se_quota"));
  assert.equal(requests.at(-2)?.method, "POST");
  assert.equal(requests.at(-1)?.method, "GET");
});

test("services list recovers executions without a local cart handle", async () => {
  await runServicesList(backend, { output: stdoutSink });
  assert.equal(mock.requests.at(-1)?.path, "/v1/service-executions?limit=50");
  assert.match(stdoutCapture.join("\n"), /service execution se_mock_1/);
  assert.match(stdoutCapture.join("\n"), /next: itpay services invoke/);
});

test("service guidance opens existing checkout after checkout is pending", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_pending",
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "scv_mock",
      status: "checkout_pending",
      phase: "checkout",
      checkout_required: true,
      next_action: "pay_checkout",
      started_at: "2026-07-05T12:00:00Z",
      created_at: "2026-07-05T12:00:00Z",
      updated_at: "2026-07-05T12:00:00Z",
    },
    capabilities: [],
    events: [],
    result_items: [],
    actions: [],
    checkout_bindings: [{ service_checkout_binding_id: "scb_1", service_execution_id: "se_pending", service_quote_lock_id: "sql_1", checkout_id: "chk_1", status: "active" }],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: [],
    refunds: [],
  });
  assert.equal(guidance.next_actions[0]?.id, "open_existing_checkout");
  assert.equal(guidance.next_actions[0]?.command, "itpay services checkout se_pending --resume --json");
});

test("service guidance waits for human grant after delivery", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_delivered",
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "scv_mock",
      status: "delivery_issued",
      phase: "delivery",
      checkout_required: false,
      next_action: "view_delivery",
      started_at: "2026-07-05T12:00:00Z",
      created_at: "2026-07-05T12:00:00Z",
      updated_at: "2026-07-05T12:00:00Z",
    },
    capabilities: [],
    events: [],
    result_items: [{
      service_capability_result_item_id: "sri_1",
      service_execution_id: "se_delivered",
      capability_id: "fuzzy_disambiguation",
      stable_hash: "hash_1",
      rank: 1,
      display_title: "小米科技有限责任公司",
      safe_payload: {},
      created_at: "2026-07-05T12:00:00Z",
    }],
    actions: [],
    checkout_bindings: [],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: [],
    refunds: [],
  });
  assert.equal(guidance.next_actions[0]?.id, "wait_for_human_agent_grant");
  assert.equal(guidance.next_actions[0]?.requires_human, true);
});

test("service guidance reads result after active human grant", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_granted",
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "scv_mock",
      status: "grant_available",
      phase: "delivery",
      checkout_required: false,
      next_action: "view_delivery",
      started_at: "2026-07-05T12:00:00Z",
      created_at: "2026-07-05T12:00:00Z",
      updated_at: "2026-07-05T12:00:00Z",
    },
    capabilities: [],
    events: [],
    result_items: [],
    actions: [],
    checkout_bindings: [],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: [{
      service_delivery_binding_id: "sdb_1",
      service_execution_id: "se_granted",
      order_id: "ord_1",
      vault_artifact_id: "va_1",
      agent_read_grant_id: "arg_1",
      status: "grant_available",
      grant_status: "active",
      grant_expires_at: "2026-07-05T12:15:00Z",
    }],
    refunds: [],
  });
  assert.equal(guidance.next_actions[0]?.id, "read_granted_result");
  assert.equal(guidance.next_actions[0]?.command, "itpay services read-result se_granted");
});

test("service guidance emits executable human selection action", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_select",
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "scv_mock",
      status: "running",
      phase: "pre_purchase",
      checkout_required: false,
      next_action: "select_candidate",
      started_at: "2026-07-05T12:00:00Z",
      created_at: "2026-07-05T12:00:00Z",
      updated_at: "2026-07-05T12:00:00Z",
    },
    capabilities: [],
    events: [],
    result_items: [{
      service_capability_result_item_id: "scri_1",
      service_execution_id: "se_select",
      capability_id: "fuzzy_disambiguation",
      stable_hash: "hash_candidate_1",
      rank: 1,
      display_title: "小米汽车科技有限公司",
      safe_payload: { company_name: "小米汽车科技有限公司" },
      created_at: "2026-07-05T12:00:00Z",
    }],
    actions: [],
    checkout_bindings: [],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: [],
    refunds: [],
  });
  assert.equal(
    guidance.next_actions[0]?.command,
    "itpay services action se_select --action select_candidate --actor-type human --status approved --candidate <rank>",
  );
});

test("service recovery guides backend outage retries", () => {
  const recovery = errorRecoveryActions(new HttpError(503, { code: "unavailable", message: "backend unavailable" }, "HTTP 503"));
  assert.equal(recovery[0]?.command, "itpay readyz");
  assert.equal(recovery[1]?.command, "echo $ITPAY_BACKEND_URL");
});

test("cart show prints items to the output sink", () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  runCartShow(session, { output: stdoutSink });
  const text = stdoutCapture.join("");
  assert.match(text, /currency=CNY/);
  assert.match(text, /v_1/);
});

test("cart session persists checkout recovery fields with owner-only permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "itpay-cart-session-")), "cart.json");
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_session",
    offerID: "o_session",
    quantity: 1,
    output: silent,
  });
  session.rememberCheckout({
    cartID: "cart_session",
    checkoutID: "chk_session",
    displayToken: "cdt_session",
    checkoutURL: "https://sandbox.itpay.ai/checkout/chk_session?display_token=cdt_session",
  });
  session.saveToFile(path);

  const persisted = JSON.parse(readFileSync(path, "utf8")) as {
    items: unknown[];
    lastCartID?: string;
    lastCheckoutID?: string;
    lastDisplayToken?: string;
    lastCheckoutURL?: string;
  };
  assert.deepEqual(persisted.items, []);
  assert.equal(persisted.lastCartID, "cart_session");
  assert.equal(persisted.lastCheckoutID, "chk_session");
  assert.equal(persisted.lastDisplayToken, "cdt_session");
  assert.equal(persisted.lastCheckoutURL, "https://sandbox.itpay.ai/checkout/chk_session?display_token=cdt_session");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const loaded = CartSession.loadFromFile(path, "CNY").show();
  assert.deepEqual(loaded.items, []);
  assert.equal(loaded.lastCartID, "cart_session");
  assert.equal(loaded.lastCheckoutID, "chk_session");
  assert.equal(loaded.lastDisplayToken, "cdt_session");
  assert.equal(loaded.lastCheckoutURL, "https://sandbox.itpay.ai/checkout/chk_session?display_token=cdt_session");
});

// --- runBuy with render plan dispatch -----------------------------------

test("runBuy (terminal) prints checkout QR + summary", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "terminal",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  // terminal renderer writes a localized header instead of the raw
  // `ITP HUMAN ACTION REQUIRED` label; assert on the agent-facing signal.
  assert.match(text, /ITP 收银台/);
  assert.match(text, /打开付款页面/);
  // cart->checkout wiring
  const cartReq = mock.requests[0]!;
  const checkoutReq = mock.requests[1]!;
  assert.equal(cartReq.path, "/v1/carts");
  assert.equal(checkoutReq.path, "/v1/checkouts");
  assert.equal((cartReq.body as { client_context: { host: string } }).client_context.host, "terminal");
  // cart session remembered the checkout
  const snap = session.show();
  assert.equal(snap.items.length, 0);
  assert.equal(snap.lastCheckoutID, "chk_1");
  assert.ok(snap.lastDisplayToken);
  assert.match(snap.lastCheckoutURL ?? "", /display_token=/);
});

test("runBuy (telegram) emits openclaw_message + inline buttons", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "telegram",
    target: "chat-42",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  const parsed = JSON.parse(text) as {
    openclaw_message: { command: string[]; if_unavailable: string };
    presentation: {
      format: string;
      buttons: Array<{ kind: string; intent?: string; ref?: string; label: string }>;
    };
  };
  assert.equal(parsed.presentation.format, "text_inline_buttons");
  assert.equal(parsed.openclaw_message.command[0], "openclaw");
  assert.ok(parsed.openclaw_message.command.includes("--target"));
  assert.ok(parsed.openclaw_message.command.includes("chat-42"));
  assert.ok(parsed.openclaw_message.if_unavailable.includes("native Telegram"));
  // ensure at least one inline button exists
  assert.ok(parsed.presentation.buttons.length >= 1);
});

test("runBuy (feishu) emits interactive card with URL + callback buttons", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "feishu",
    target: "ou_xxx",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  const parsed = JSON.parse(text) as {
    message: { host: string; msg_type: string; card: { elements: Array<Record<string, unknown>> } };
  };
  assert.equal(parsed.message.host, "feishu");
  assert.equal(parsed.message.msg_type, "interactive");
  assert.ok(parsed.message.card.elements.some((el) => el.tag === "note"));
  assert.ok(parsed.message.card.elements.some((el) => el.tag === "action"));
});

test("runBuy (lark) uses lark host + open_id", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "lark",
    target: "ou_lark",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  const parsed = JSON.parse(text) as { message: { host: string; receive_id_type: string } };
  assert.equal(parsed.message.host, "lark");
  assert.equal(parsed.message.receive_id_type, "open_id");
});

test("runBuy (markdown) renders a markdown block with a QR image and a link", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  assert.match(text, /AGENT ACTION REQUIRED/);
  assert.match(text, /ItPay 付款/);
  assert.doesNotMatch(text, /data:image\/png;base64,/);
  assert.match(text, /!\[ItPay 付款二维码\]\(</);
  assert.match(text, /打开 ItPay 付款页面/);
  assert.match(text, /display_token=/);
});

test("runBuy (plain-chat) prints a short text + URL block", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "plain-chat",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  assert.match(text, /open: https:\/\//);
  assert.match(text, /open: .*display_token=/);
  assert.match(text, /qr_image:/);
});

test("runBuy --pay sends display_token to payment intent creation", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_pay_token",
    offerID: "o_pay_token",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, { ...config, ideImageAttach: false }, {
    cartSession: session,
    host: "plain-chat",
    pay: true,
    noWait: true,
    jsonOutput: true,
    output: silent,
  });
  const req = mock.requests.find((record) => record.path.endsWith("/payment-intents"));
  assert.ok(req);
  assert.equal((req!.body as { display_token?: string }).display_token, `cdt_${session.show().lastCheckoutID}_secret`);
});

test("dispatchInteractionRequest (terminal) renders input fields", async () => {
  await dispatchInteractionRequest(
    "terminal",
    {
      kind: "input",
      id: "collect_contact",
      title: "Collect buyer contact",
      prompt: "Ask the buyer for their email and phone number.",
      fields: [
        { id: "email", label: "Email", inputType: "email", required: true, placeholder: "buyer@example.com" },
        { id: "phone", label: "Phone", inputType: "phone", placeholder: "+86 138..." },
      ],
      submitLabel: "Send info",
    },
    { isTTY: true, asciiWidth: 16, output: stdoutSink },
  );
  const text = stdoutCapture.join("");
  assert.match(text, /ITP INPUT REQUIRED \[input\]/);
  assert.match(text, /Collect buyer contact/);
  assert.match(text, /reply_json:/);
  assert.match(text, /"email":"<email>"/);
});

test("dispatchInteractionRequest (markdown) emits structured input request for agent hosts", async () => {
  await dispatchInteractionRequest(
    "codex",
    {
      kind: "input",
      id: "collect_identity",
      title: "Collect buyer identity",
      prompt: "Please ask the buyer to reply with their legal name.",
      fields: [{ id: "legal_name", label: "Legal name", inputType: "text", required: true }],
      submitLabel: "Submit identity",
    },
    { output: stdoutSink },
  );
  const text = stdoutCapture.join("");
  // markdown renderer emits a fillable JSON template; agents reconstruct
  // the request by parsing the `json` code block.
  assert.match(text, /```json/);
  assert.match(text, /"legal_name":\s*"<text>"/);
  assert.match(text, /Collect buyer identity/);
});

test("runBuy requests missing contact info via interaction request before checkout", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  const result = await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    requiredContactFields: ["email", "phone"],
    output: stdoutSink,
  });
  assert.equal(result.kind, "interaction_requested");
  assert.equal(mock.requests.length, 0);
  const text = stdoutCapture.join("");
  // markdown renderer emits a fillable JSON template; the agent
  // adapter reconstructs the request from the code block keys.
  assert.match(text, /```json/);
  assert.match(text, /"email":\s*"<email>"/);
  assert.match(text, /Collect buyer contact/);
});

test("mock Trae/Codex adapter consumes markdown block and replays filled contact info", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });

  const firstPass = await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    requiredContactFields: ["email", "phone"],
    output: stdoutSink,
  });
  assert.equal(firstPass.kind, "interaction_requested");

  const markdown = stdoutCapture.join("");
  const inputRequest = extractInputRequestFromMarkdown(markdown);
  const contact = submitAgentInputRequest(inputRequest, {
    email: "buyer@example.com",
    phone: "+86 13800000000",
  });

  stdoutCapture = [];
  const secondPass = await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    contact,
    requiredContactFields: ["email", "phone"],
    output: stdoutSink,
  });
  assert.equal(secondPass.kind, "checkout_rendered");
  assert.equal(mock.requests[0]!.path, "/v1/carts");
  assert.equal(mock.requests[1]!.path, "/v1/checkouts");
  assert.deepEqual((mock.requests[1]!.body as { delivery_contact?: Record<string, string> }).delivery_contact, contact);
  assert.match(stdoutCapture.join(""), /AGENT ACTION REQUIRED/);
  assert.match(stdoutCapture.join(""), /!\[ItPay 付款二维码\]\(</);
});

test("dispatchInteractionRequest (telegram) emits selector buttons for chat hosts", async () => {
  await dispatchInteractionRequest(
    "telegram",
    {
      kind: "selector",
      id: "pick_payment_method",
      title: "Choose a payment method",
      prompt: "Ask the buyer to choose their payment method.",
      options: [
        { id: "alipay", label: "Alipay", value: "alipay" },
        { id: "wechatpay", label: "WeChat Pay", value: "wechatpay" },
      ],
      selectionMode: "single",
      submitLabel: "Confirm method",
    },
    { target: "chat-99", output: stdoutSink },
  );
  const parsed = JSON.parse(stdoutCapture.join("")) as {
    openclaw_message: { command: string[] };
    presentation: {
      format: string;
      buttons: Array<{ intent?: string; ref?: string; label: string }>;
      selector_request: { type: string; selection_mode: string };
    };
  };
  assert.equal(parsed.presentation.format, "text_inline_buttons");
  assert.equal(parsed.presentation.selector_request.type, "itpay_selector_request");
  assert.equal(parsed.presentation.buttons[0]!.intent, "submit_selector_option");
  assert.equal(parsed.presentation.buttons[0]!.ref, "pick_payment_method:alipay");
  assert.ok(parsed.openclaw_message.command.includes("chat-99"));
});

test("dispatchInteractionRequest (feishu) emits input metadata for reply-based collection", async () => {
  await dispatchInteractionRequest(
    "feishu",
    {
      kind: "input",
      id: "collect_shipping",
      title: "Collect shipping info",
      prompt: "Please ask the buyer to reply with their address.",
      fields: [{ id: "address", label: "Address", inputType: "textarea", required: true }],
      submitLabel: "Send address",
    },
    { target: "ou_input", output: stdoutSink },
  );
  const parsed = JSON.parse(stdoutCapture.join("")) as {
    message: {
      host: string;
      input_request: { type: string; id: string };
      card: { elements: Array<{ tag?: string }> };
    };
  };
  assert.equal(parsed.message.host, "feishu");
  assert.equal(parsed.message.input_request.type, "itpay_input_request");
  assert.equal(parsed.message.input_request.id, "collect_shipping");
});

test("runBuy rejects when host is missing for IM clients", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await assert.rejects(
    runBuy(backend, config, { cartSession: session, host: "telegram", output: silent }),
    /target_required/,
  );
});

test("runBuy rejects when the cart is empty", async () => {
  const session = new CartSession("CNY");
  await assert.rejects(
    runBuy(backend, config, { cartSession: session, host: "terminal", output: silent }),
    /cart is empty/,
  );
});

test("buildCheckoutQRPlan pins the brand QR payload", () => {
  const plan = buildCheckoutQRPlan({
    host: "terminal",
    checkoutID: "chk_x",
    checkoutURL: "https://sandbox.itpay.ai/checkout/chk_x?display_token=cdt_x",
    displayToken: "cdt_x",
    qrPayload: "https://sandbox.itpay.ai/checkout/chk_x?display_token=cdt_x",
    nextAction: "open_checkout",
  });
  assert.equal(plan.kind, "checkout_qr");
  assert.equal(plan.host, "terminal");
  assert.equal(plan.checkoutID, "chk_x");
  assert.ok(plan.preferredQRSources[0]!.includes("display_token="));
  assert.ok(plan.platform.links[0]!.url.includes("display_token="));
  assert.ok(plan.platform.buttons[0]!.url?.includes("display_token="));
});

// --- per-command smoke (kept from prior round) ---------------------------

test("readyz probes /v1/readyz", async () => {
  await runReadyz(backend, { output: silent });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/readyz");
});

test("checkout reads canonical presentation with display_token", async () => {
  await runCheckoutPresentation(backend, {
    checkoutID: "chk_demo",
    displayToken: "cdt_demo",
    output: silent,
    baseURL: mock.url,
  });
  const req = mock.requests.find((item) => item.path === "/v1/checkouts/chk_demo/presentation?display_token=cdt_demo")!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/checkouts/chk_demo/presentation?display_token=cdt_demo");
  assert.ok(mock.requests.some((item) => item.path === "/v1/checkouts/chk_demo/qr.png?display_token=cdt_demo"));
});

test("main buy persists checkout recovery state and consumes local cart", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-buy-"));
  const sessionPath = join(home, "cart.json");
  await runCLI(
    ["buy", "--host", "plain-chat", "--item", "item_1", "--variant", "v_cli", "--offer", "o_cli"],
    {
      ITPAY_BACKEND_URL: mock.url,
      ITPAY_CART_SESSION_PATH: sessionPath,
      ITPAY_IDE_IMAGE_ATTACH: "0",
      ITPAY_IDEMPOTENCY_KEY: "cli_command_key",
      ITPAY_AGENT_TYPE: "codex-cli",
      HOME: home,
    },
  );

  const saved = JSON.parse(readFileSync(sessionPath, "utf8")) as {
    items: unknown[];
    lastCartID?: string;
    lastCheckoutID?: string;
    lastDisplayToken?: string;
    lastCheckoutURL?: string;
  };
  assert.deepEqual(saved.items, []);
  assert.match(saved.lastCartID ?? "", /^cart_/);
  assert.match(saved.lastCheckoutID ?? "", /^chk_/);
  assert.equal(saved.lastDisplayToken, `cdt_${saved.lastCheckoutID}_secret`);
  assert.match(saved.lastCheckoutURL ?? "", /display_token=/);
  assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
});

test("main checkout without args uses saved checkout id and display token", async () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "itpay-cli-checkout-")), "cart.json");
  const session = new CartSession("CNY");
  session.rememberCheckout({
    cartID: "cart_saved",
    checkoutID: "chk_saved",
    displayToken: "cdt_saved",
    checkoutURL: "https://sandbox.itpay.ai/checkout/chk_saved?display_token=cdt_saved",
  });
  session.saveToFile(sessionPath);

  await runCLI(["checkout"], {
    ITPAY_BACKEND_URL: mock.url,
    ITPAY_CART_SESSION_PATH: sessionPath,
    ITPAY_IDE_IMAGE_ATTACH: "0",
  });

  const req = mock.requests.find((item) => item.path === "/v1/checkouts/chk_saved/presentation?display_token=cdt_saved")!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/checkouts/chk_saved/presentation?display_token=cdt_saved");
  assert.doesNotMatch(req.path, /undefined/);
  assert.ok(mock.requests.some((item) => item.path === "/v1/checkouts/chk_saved/qr.png?display_token=cdt_saved"));
});

test("expired saved service checkout token returns an executable resume instruction", async () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "itpay-cli-expired-checkout-")), "cart.json");
  const session = new CartSession("CNY");
  session.rememberCheckout({
    cartID: "cart_expired",
    checkoutID: "chk_expired",
    displayToken: "cdt_expired",
    checkoutURL: "https://sandbox.itpay.ai/checkout/chk_expired?display_token=cdt_expired",
    serviceExecutionID: "se_expired",
  });
  session.saveToFile(sessionPath);

  await assert.rejects(
    runCLI(["checkout"], {
      ITPAY_BACKEND_URL: mock.url,
      ITPAY_CART_SESSION_PATH: sessionPath,
      ITPAY_IDE_IMAGE_ATTACH: "0",
    }),
    (error: unknown) => {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      return stderr.includes("itpay services checkout se_expired --resume --json");
    },
  );
});

test("progressive service instructions execute unchanged across CLI processes", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-progressive-"));
  const env = {
    ITPAY_BACKEND_URL: mock.url,
    ITPAY_AGENT_TYPE: "codex-desktop",
    ITPAY_IDE_IMAGE_ATTACH: "0",
    HOME: home,
  };
  const invoked = await runCLI([
    "services", "invoke", "se_instruction", "--capability", "fuzzy_disambiguation",
    "--input", "keyword=小米", "--json",
  ], env);
  assert.match(invoked.stdout, /service_execution_id/);

  const created = JSON.parse((await runCLI([
    "services", "checkout", "se_instruction", "--capability", "precise_report",
    "--email", "buyer@example.com", "--json",
  ], env)).stdout) as { checkout_id: string; display_token: string };
  const resumed = JSON.parse((await runCLI([
    "services", "checkout", "se_instruction", "--resume", "--json",
  ], env)).stdout) as { checkout_id: string; display_token: string };
  assert.equal(resumed.checkout_id, created.checkout_id);
  assert.notEqual(resumed.display_token, created.display_token);
});

test("pay creates a payment intent with Idempotency-Key", async () => {
  await runPay(backend, config, { checkoutID: "chk_pay", method: "alipay", output: silent });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/checkouts/chk_pay/payment-intents");
  assert.equal(req.headers["idempotency-key"], "cli_smoke_key");
  assert.equal((req.body as { payment_method_type: string }).payment_method_type, "alipay");
});

test("services checkout JSON returns ItPay checkout handoff, not provider QR", async () => {
  const stdoutCaptureJSON: string[] = [];
  await runServicesCheckout(backend, config, "se_demo", "precise_report", {
    email: "buyer@example.com",
    host: "plain-chat",
    jsonOutput: true,
    output: (line) => stdoutCaptureJSON.push(line),
  });
  const json = JSON.parse(stdoutCaptureJSON.join("")) as {
    kind: string;
    next_action: string;
    checkout_url: string;
    qr_payload: string;
    qr_png_url?: string;
    warning?: string;
    brand_qr_status?: string;
    brand_qr_data_url?: string;
    agent_action?: { must_send_to_user: boolean; markdown: string; after_visible_action?: { command: string } };
  };
  assert.equal(json.kind, "checkout_handoff_required");
  assert.equal(json.next_action, "open_human_checkout");
  assert.match(json.checkout_url, /^https:\/\/sandbox\.itpay\.ai\/checkout\/chk_/);
  assert.match(json.qr_payload, /display_token=/);
  assert.match(json.qr_png_url ?? "", /^\/v1\/checkouts\/chk_\d+\/qr\.png\?display_token=/);
  assert.match(json.warning ?? "", /Do not call `itpay pay`/);
  assert.equal(json.brand_qr_status, "downloaded");
  assert.equal(json.brand_qr_data_url, undefined);
  assert.equal(json.agent_action?.must_send_to_user, true);
  assert.match(json.agent_action?.markdown ?? "", /!\[ItPay 付款二维码\]\(</);
  assert.match(json.agent_action?.markdown ?? "", /打开 ItPay 付款页面/);
  assert.match(json.agent_action?.after_visible_action?.command ?? "", /itpay checkout --id/);
  assert.ok(!JSON.stringify(json).includes("qr.alipay.com"));
  assert.ok(mock.requests.some((req) => req.path.includes("/qr.png?display_token=")));
  assert.equal(JSON.stringify(json).includes("agent_access_token"), false);
});

test("services checkout resume reissues the same checkout and persists before output", async () => {
  const firstOutput: string[] = [];
  await runServicesCheckout(backend, config, "se_resume", "precise_report", {
    email: "buyer@example.com",
    host: "codex",
    jsonOutput: true,
    output: (line) => firstOutput.push(line),
  });
  const first = JSON.parse(firstOutput.join("")) as { checkout_id: string; display_token: string };

  let persisted = false;
  const resumedOutput: string[] = [];
  await runServicesCheckout(backend, config, "se_resume", undefined, {
    resume: true,
    host: "codex",
    jsonOutput: true,
    persistHandoff: (handoff) => {
      persisted = handoff.checkoutID === first.checkout_id && handoff.displayToken !== first.display_token;
    },
    output: (line) => {
      assert.equal(persisted, true, "handoff must be persisted before CLI output");
      resumedOutput.push(line);
    },
  });
  const resumed = JSON.parse(resumedOutput.join("")) as { checkout_id: string; display_token: string; handoff_reissued: boolean };
  assert.equal(resumed.checkout_id, first.checkout_id);
  assert.notEqual(resumed.display_token, first.display_token);
  assert.equal(resumed.handoff_reissued, true);
  const requests = mock.requests.filter((request) => request.path === "/v1/service-executions/se_resume/checkout");
  assert.equal(requests.length, 2);
  assert.equal((requests[1]?.body as { resume?: boolean }).resume, true);
  assert.equal((requests[1]?.body as { delivery_contact?: unknown }).delivery_contact, undefined);
});

test("services read-result relies on device authority instead of a checkout token", async () => {
  await runServicesReadResult(backend, "se_granted", { output: silent });
  const req = mock.requests.at(-1)!;
  assert.equal(req.path, "/v1/service-executions/se_granted/granted-result");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.path.includes("agent_device_id"), false);
});

test("services action rejects unsupported statuses before HTTP", async () => {
  await assert.rejects(
    runServicesAction(backend, "se_bad_status", "select_candidate", {}, {
      status: "completed",
      output: silent,
    }),
    /invalid --status "completed"/,
  );
  assert.equal(mock.requests.some((req) => req.path.includes("/v1/service-executions/se_bad_status/actions")), false);
});

test("services action resolves a human-selected candidate rank from the execution", async () => {
  await runServicesInvoke(backend, config, "se_select_by_rank", "fuzzy_disambiguation", { keyword: "小米" }, { output: silent });
  await runServicesAction(backend, "se_select_by_rank", "select_candidate", {}, {
    actorType: "human",
    status: "approved",
    candidateRank: 1,
    output: silent,
  });
  const requests = mock.requests.filter((request) => request.path.includes("/v1/service-executions/se_select_by_rank"));
  assert.equal(requests.at(-2)?.method, "GET");
  assert.equal(requests.at(-1)?.method, "POST");
  assert.deepEqual(requests.at(-1)?.body, {
    action_type: "select_candidate",
    actor_type: "human",
    status: "approved",
    result_item_id: "scri_1",
    selected_candidate_hash: "hash_candidate_1",
    input_snapshot: {},
  });
});

test("catalog list supports JSON output", async () => {
  const output: string[] = [];
  await runCatalogList(backend, { jsonOutput: true, output: (line) => output.push(line) });
  const parsed = JSON.parse(output.join("")) as { manifest: { items: Array<{ catalog_item_id: string; service_flow?: { discovery: { free_quota_limit?: number } } }> } };
  assert.ok(parsed.manifest.items.some((item) => item.catalog_item_id === "cat_service"));
  assert.equal(parsed.manifest.items[0]?.service_flow?.discovery.free_quota_limit, 3);
});

test("catalog text explains auxiliary discovery before the primary service", async () => {
  const output: string[] = [];
  await runCatalogList(backend, { output: (line) => output.push(line) });
  const text = output.join("");
  assert.match(text, /每台已登记设备可免费使用 3 次/);
  assert.match(text, /免费次数用完后：¥0\.10\/次，继续使用该辅助步骤；结果直接返回给 agent，不需要邮箱/);
  assert.match(text, /确认主体后：Precise company report，¥0\.50\/次/);
  assert.doesNotMatch(text, /how it works|purchasable offers|included:/);
  assert.match(text, /claim link/);
});

test("services checkout renders the branded checkout QR by default", async () => {
  await runServicesCheckout(backend, config, "se_render", "precise_report", {
    email: "buyer@example.com",
    host: "codex",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  assert.match(text, /AGENT ACTION REQUIRED/);
  assert.match(text, /!\[ItPay 付款二维码\]\(</);
  assert.match(text, /打开 ItPay 付款页面/);
  assert.match(text, /display_token=/);
  assert.ok(mock.requests.some((req) => req.path.includes("/qr.png?display_token=")));
});

test("services checkout requires delivery email before QR handoff", async () => {
  await assert.rejects(
    runServicesCheckout(backend, config, "se_missing_email", "precise_report", { output: silent }),
    /delivery email is required/,
  );
});

test("services checkout does not require email for an agent-visible paid result", async () => {
  await runServicesCheckout(backend, config, "se_paid_fuzzy", "fuzzy_disambiguation_paid", { output: silent });
  assert.ok(mock.requests.some((request) =>
    request.method === "POST" && request.path === "/v1/service-executions/se_paid_fuzzy/checkout",
  ));
});

test("order reads one canonical order by id", async () => {
  await runOrder(backend, "ord_1", { output: silent });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/orders/ord_1");
});

test("orders requires an account-scoped bearer", async () => {
  const configWithoutBearer = { ...config };
  delete configWithoutBearer.bearerToken;
  await assert.rejects(
    runListOrders(backend, configWithoutBearer, { limit: 10, output: silent }),
    /ITPAY_BEARER_TOKEN is required/,
  );
});

test("orders lists account orders with a valid bearer", async () => {
  await runListOrders(backend, { ...config, bearerToken: "account_token" }, { limit: 5, output: silent });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/me/orders?limit=5");
  assert.equal(req.headers["authorization"], "Bearer account_token");
});

test("orders surfaces account_scope_required as HttpError", async () => {
  await assert.rejects(
    runListOrders(backend, { ...config, bearerToken: "order_token" }, { limit: 5, output: silent }),
    (error: unknown) => (error as { code?: string }).code === "account_scope_required",
  );
});

test("refund issues a refund request with Idempotency-Key", async () => {
  await runRefund(backend, { ...config, bearerToken: "account_token" }, {
    orderID: "ord_42",
    reason: "buyer_requested",
    output: silent,
  });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/orders/ord_42/refunds");
  assert.equal(req.headers.authorization, "Bearer account_token");
  assert.equal(req.headers["idempotency-key"], "cli_smoke_key");
  assert.deepEqual(req.body, { reason: "buyer_requested" });
});

// --- IDE image attach contract -----------------------------------------

test("runBuy attaches the brand QR PNG to a stable local path", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_attach",
    offerID: "o_attach",
    quantity: 1,
    output: silent,
  });
  const result = await runBuy(backend, config, {
    cartSession: session,
    host: "terminal",
    output: silent,
  });
  assert.equal(result.kind, "checkout_rendered");
  const attach = result.plan.ideImageAttach;
  assert.ok(attach);
  assert.equal(attach!.status, "downloaded");
  assert.ok(attach!.localPath.length > 0);
  assert.match(attach!.localPath, /itpay-v3-checkout-chk_\d+-/);
  // PNG body is on disk and starts with the PNG magic
  const buf = readFileSync(attach!.localPath);
  assert.equal(buf[0], 0x89);
  assert.equal(buf[1], 0x50);
  // mock backend recorded the qr.png request
  const lastReq = mock.requests.at(-1)!;
  assert.match(lastReq.path, /^\/v1\/checkouts\/chk_\d+\/qr\.png/);
});

test("runBuy mirrors the brand QR into the canonical directory", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_mirror",
    offerID: "o_mirror",
    quantity: 1,
    output: silent,
  });
  const result = await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    output: silent,
  });
  assert.equal(result.kind, "checkout_rendered");
  const attach = result.plan.ideImageAttach;
  assert.ok(attach);
  // canonical path always exists, mirrors may be empty when /tmp and
  // tmpdir() resolve to the same location
  const stat = statSync(attach!.localPath);
  assert.ok(stat.size > 0);
});

test("runBuy disables IDE attach when ITPAY_IDE_IMAGE_ATTACH=0", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_off",
    offerID: "o_off",
    quantity: 1,
    output: silent,
  });
  const result = await runBuy(backend, { ...config, ideImageAttach: false }, {
    cartSession: session,
    host: "plain-chat",
    output: silent,
  });
  assert.equal(result.kind, "checkout_rendered");
  const attach = result.plan.ideImageAttach;
  assert.ok(attach);
  assert.equal(attach!.status, "disabled");
  assert.equal(attach!.localPath, "");
  // did not hit the backend's /qr.png endpoint
  const lastReq = mock.requests.at(-1)!;
  assert.equal(lastReq.path, "/v1/checkouts");
});

test("runBuy surfaces attach failure when the brand QR HTTP fails", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_fail",
    offerID: "o_fail",
    quantity: 1,
    output: silent,
  });
  const failingFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("/qr.png")) {
      return new Response("boom", { status: 503 });
    }
    return globalThis.fetch(input as Request | URL | string);
  };
  const result = await runBuy(backend, config, {
    cartSession: session,
    host: "telegram",
    target: "chat-fail",
    fetchImpl: failingFetch,
    output: silent,
  });
  assert.equal(result.kind, "checkout_rendered");
  const attach = result.plan.ideImageAttach;
  assert.ok(attach);
  assert.equal(attach!.status, "failed");
  assert.match(attach!.error ?? "", /http=503/);
});

test("runBuy JSON output carries brand_qr_status / mirrors / stable_name", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_json",
    offerID: "o_json",
    quantity: 1,
    output: silent,
  });
  const stdoutCaptureJSON: string[] = [];
  const jsonSink: OutputSink = (line) => stdoutCaptureJSON.push(line);
  await runBuy(backend, config, {
    cartSession: session,
    host: "plain-chat",
    jsonOutput: true,
    output: jsonSink,
  });
  const json = JSON.parse(stdoutCaptureJSON.join("")) as {
    brand_qr_status?: string;
    brand_qr_local_path?: string;
    brand_qr_stable_name?: string;
    brand_qr_data_url?: string;
    brand_qr_mime_type?: string;
  };
  assert.equal(json.brand_qr_status, "downloaded");
  assert.ok(json.brand_qr_local_path);
  assert.match(json.brand_qr_stable_name ?? "", /itpay-v3-checkout-chk_/);
  assert.match(json.brand_qr_data_url ?? "", /^data:image\/png;base64,/);
  assert.equal(json.brand_qr_mime_type, "image/png");
});

test("buy JSON output carries service execution refs from cart lines", () => {
  const json = buildJSONOutput({
    checkout: {
      checkout: { checkout_id: "chk_1", status: "quote_bound", amount_minor: 50, currency: "CNY" },
      checkout_url: "https://test.itpay.ai/checkout/chk_1",
      display_token: "cdt_1",
      qr_payload: "https://test.itpay.ai/checkout/chk_1?display_token=cdt_1",
    },
    cart: {
      cart_id: "cart_1",
      status: "active",
      amount_minor: 50,
      currency: "CNY",
      items: [{
        title: "精准企业报告",
        quantity: 1,
        amount_minor: 50,
        currency: "CNY",
        service_execution_id: "se_1",
        service_capability_id: "scc_qizhidao_precise_v1",
      }],
    },
    waitStatus: "skipped",
  });

  assert.deepEqual(json.service_executions, [{
    service_execution_id: "se_1",
    service_capability_id: "scc_qizhidao_precise_v1",
    title: "精准企业报告",
  }]);
});

test("markdown renderer keeps command output bounded and delegates image attachment to the host", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_md",
    offerID: "o_md",
    quantity: 1,
    output: silent,
  });
  await runBuy(backend, config, {
    cartSession: session,
    host: "codex",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  const dataURLs = text.match(/data:image\/png;base64,/g) ?? [];
  assert.equal(dataURLs.length, 0);
  assert.ok(Buffer.byteLength(text) < 12_000, `markdown handoff unexpectedly large: ${Buffer.byteLength(text)} bytes`);
  assert.match(text, /!\[ItPay 付款二维码\]\(</);
});
