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
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HttpClient, HttpError } from "../src/client/http.js";
import { BackendClient } from "../src/client/backend.js";
import type { ServiceExecutionReadModel } from "../src/client/types.js";
import { CartSession } from "../src/state/cart_session.js";
import {
  HOSTS_REQUIRING_TARGET,
  defaultHostForAgentType,
  normalizeHost,
  validateContext,
} from "../src/state/client_context.js";
import { runBuy, buildCheckoutQRPlan } from "../src/commands/buy.js";
import { CommandContractError, buildServiceInvokedGuidance, buildServiceReadModelGuidance, errorRecoveryActions } from "../src/commands/guidance.js";
import { runReadyz } from "../src/commands/readyz.js";
import { runCheckoutPresentation } from "../src/commands/checkout.js";
import { runPay } from "../src/commands/pay.js";
import { runOrder } from "../src/commands/order.js";
import { runListOrders } from "../src/commands/orders.js";
import { runCancelRefund, runGetRefund, runListRefunds, runRefund, runWatchRefund } from "../src/commands/refund.js";
import { runCartAdd, runCartShow, runCartShowServer, runCartRemove, runCartClear, runCartRemoveServer, runCartAbandonServer, runCartAddServer, runCartAddQuoteServer, runCartNext } from "../src/commands/cart.js";
import { runCatalogList } from "../src/commands/catalog.js";
import { runNext } from "../src/commands/next.js";
import { runServicesAction, runServicesCheckout, runServicesEvents, runServicesGet, runServicesInvoke, runServicesList, runServicesNext, runServicesQuote, runServicesReadResult, runServicesStart } from "../src/commands/services.js";
import { dispatchInteractionRequest } from "../src/render/interaction.js";
import { DEFAULT_BASE_URL, type CLIConfig } from "../src/state/config.js";
import type { OutputSink } from "../src/render/sink.js";
import { startMockBackend, type MockBackendHandle } from "./mock_backend.js";

const execFileAsync = promisify(execFile);
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_BIN = resolve(CLI_ROOT, "node_modules/.bin/tsx");
const CLI_ENTRY = resolve(CLI_ROOT, "src/main.ts");
const AGENT_TYPES = ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"] as const;

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

function withoutQualifiedAgentType(output: string): string {
  return output.replace(/itpay --agent-type (?:codex-desktop|codex-cli|claude-code-desktop|claude-code-cli|workbuddy) /g, "itpay ");
}

function assertQualifiedAgentType(output: string, agentType: string): void {
  assert.match(output, new RegExp(`itpay --agent-type ${agentType} `));
}

before(async () => {
  mock = await startMockBackend();
  config = {
    baseURL: mock.url,
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

test("beta backend is the package default", () => {
  assert.equal(DEFAULT_BASE_URL, "https://dev.itpay.ai");
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
  assert.equal(defaultHostForAgentType("codex-cli"), "terminal");
  assert.equal(defaultHostForAgentType("claude-code-desktop"), "claude-code");
  assert.equal(defaultHostForAgentType("claude-code-cli"), "terminal");
  assert.equal(defaultHostForAgentType("workbuddy"), "plain-chat");
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
  runCartClear(session, { output: silent });
  assert.equal(session.show().items.length, 0);
});

test("server cart remove and abandon call canonical backend routes", async () => {
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_server_1", cartItemID: "cart_item_1", serviceExecutionID: "se_removed" });
  await runCartRemoveServer(backend, session, undefined, { jsonOutput: true, output: stdoutSink });
  assert.equal(mock.requests.at(-1)?.method, "DELETE");
  assert.equal(mock.requests.at(-1)?.path, "/v1/carts/cart_server_1/items/cart_item_1");
  const removed = JSON.parse(stdoutCapture.join("")) as { status: string; result: { remaining_item_count: number }; next: { command: string } };
  assert.equal(removed.status, "removed");
  assert.equal(removed.result.remaining_item_count, 0);
  assert.equal(removed.next.command, "itpay cart next --json");
  assert.equal(session.lastCartItemID, undefined);
  assert.equal(session.lastServiceExecutionID, undefined);

  stdoutCapture = [];
  runNext(session, { jsonOutput: true, output: stdoutSink });
  const next = JSON.parse(stdoutCapture.join("")) as { result: { resource_type: string } };
  assert.equal(next.result.resource_type, "cart");

  await runCartAbandonServer(backend, session, { output: silent });
  assert.equal(mock.requests.at(-1)?.method, "DELETE");
  assert.equal(mock.requests.at(-1)?.path, "/v1/carts/cart_server_1");
  assert.equal(session.lastCartID, undefined);
});

test("cart remove parser supports canonical and local scopes across Agent Types", async () => {
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const home = mkdtempSync(join(tmpdir(), `itpay-cart-remove-${agentType}-`));
    const session = new CartSession("CNY");
    session.rememberServerCart({ cartID: `cart_remove_${agentType}`, cartItemID: "ci_remove", serviceExecutionID: "se_remove" });
    session.saveToFile(join(home, ".itpay-v3", "cart.json"));
    const result = await runCLI(["--agent-type", agentType, "cart", "remove", "--line", "ci_remove", "--json"], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: home,
    });
    const envelope = JSON.parse(result.stdout) as { status: string; result: { cart_item_id: string }; next: { command: string } };
    assert.equal(envelope.status, "removed");
    assert.equal(envelope.result.cart_item_id, "ci_remove");
    assert.equal(envelope.next.command, `itpay --agent-type ${agentType} cart next --json`);
    assert.equal(result.stderr, "");
  }

  const localHome = mkdtempSync(join(tmpdir(), "itpay-cart-remove-local-"));
  const local = new CartSession("CNY");
  runCartAdd(local, { catalogItemID: "i", catalogVariantID: "v", offerID: "o", quantity: 1, output: silent });
  local.saveToFile(join(localHome, ".itpay-v3", "cart.json"));
  const localResult = await runCLI([
    "--agent-type", "workbuddy", "cart", "remove", "--local", "--variant", "v", "--offer", "o", "--json",
  ], { ITPAY_BACKEND_URL: mock.url, HOME: localHome });
  const localEnvelope = JSON.parse(localResult.stdout) as { status: string; next: { command: string } };
  assert.equal(localEnvelope.status, "removed_local");
  assert.equal(localEnvelope.next.command, "itpay --agent-type workbuddy cart show --local --json");
});

test("cart remove validates scope before HTTP and preserves locked handles", async () => {
  const requestCount = mock.requests.length;
  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "cart", "remove", "--variant", "v", "--offer", "o", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: mkdtempSync(join(tmpdir(), "itpay-cart-remove-invalid-")) },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "cart_remove_scope_invalid");
      return true;
    },
  );
  assert.equal(mock.requests.length, requestCount);

  const locked = new CartSession("CNY");
  locked.rememberServerCart({ cartID: "cart_locked", cartItemID: "ci_locked", serviceExecutionID: "se_locked" });
  const lockedBackend = {
    removeCartItem: async () => { throw new HttpError(409, { code: "cart_item_locked", message: "cart item is locked" }, "HTTP 409"); },
  } as unknown as BackendClient;
  await assert.rejects(runCartRemoveServer(lockedBackend, locked, "ci_locked", { output: silent }), /cart item is locked/);
  assert.equal(locked.lastCartItemID, "ci_locked");
  assert.equal(locked.lastServiceExecutionID, "se_locked");
});

test("server cart clear preserves recovery handles when canonical cart is locked", async () => {
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_locked", cartItemID: "cart_item_locked", serviceExecutionID: "se_locked" });
  const lockedBackend = {
    abandonCart: async () => {
      throw new HttpError(409, { code: "cart_item_locked", message: "cart item is locked" }, "HTTP 409");
    },
  } as unknown as BackendClient;

  await assert.rejects(runCartAbandonServer(lockedBackend, session, { jsonOutput: true, output: stdoutSink }), /cart item is locked/);
  assert.equal(session.lastCartID, "cart_locked");
  assert.equal(session.lastCartItemID, "cart_item_locked");
  assert.equal(session.lastServiceExecutionID, "se_locked");
  assert.equal(stdoutCapture.join(""), "");
});

test("cart clear parser returns canonical and explicit local contracts across Agent Types", async () => {
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const home = mkdtempSync(join(tmpdir(), `itpay-cart-clear-${agentType}-`));
    const session = new CartSession("CNY");
    session.rememberServerCart({ cartID: `cart_clear_${agentType}`, cartItemID: "ci_clear", serviceExecutionID: "se_clear" });
    session.saveToFile(join(home, ".itpay-v3", "cart.json"));
    const result = await runCLI(["--agent-type", agentType, "cart", "clear", "--json"], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: home,
    });
    const envelope = JSON.parse(result.stdout) as { status: string; result: { server_abandoned: boolean }; next: { command: string } };
    assert.equal(envelope.status, "abandoned");
    assert.equal(envelope.result.server_abandoned, true);
    assert.equal(envelope.next.command, `itpay --agent-type ${agentType} catalog list --json`);
    const persisted = CartSession.loadFromFile(join(home, ".itpay-v3", "cart.json"), "CNY");
    assert.equal(persisted.lastCartID, undefined);
    assert.equal(persisted.lastServiceExecutionID, undefined);
  }

  const localHome = mkdtempSync(join(tmpdir(), "itpay-cart-clear-local-"));
  const local = new CartSession("CNY");
  local.rememberServerCart({ cartID: "cart_not_abandoned", cartItemID: "ci_local" });
  runCartAdd(local, { catalogItemID: "i", catalogVariantID: "v", offerID: "o", quantity: 1, output: silent });
  local.saveToFile(join(localHome, ".itpay-v3", "cart.json"));
  const requestCount = mock.requests.length;
  const localResult = await runCLI(["--agent-type", "workbuddy", "cart", "clear", "--local", "--json"], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: localHome,
  });
  const localEnvelope = JSON.parse(localResult.stdout) as { status: string; result: { server_abandoned: boolean; local_state_cleared: boolean } };
  assert.equal(localEnvelope.status, "cleared_local");
  assert.deepEqual(localEnvelope.result, { server_abandoned: false, local_state_cleared: true });
  assert.equal(mock.requests.length, requestCount);
});

test("cart clear without a canonical handle is non-mutating and recoverable", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, { catalogItemID: "i", catalogVariantID: "v", offerID: "o", quantity: 1, output: silent });
  const requestCount = mock.requests.length;
  await runCartAbandonServer(backend, session, { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as { status: string; next: { command: string } };
  assert.equal(envelope.status, "cart_handle_missing");
  assert.equal(envelope.next.command, "itpay next --json");
  assert.equal(session.show().items.length, 1);
  assert.equal(mock.requests.length, requestCount);
});

test("server cart add returns one compact Service Execution handoff", async () => {
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
    status: string;
    result: { cart_id: string; cart_item_id: string; service_execution_id?: string; title: string; amount: string };
    next: { command: string };
  };
  assert.equal(parsed.status, "added");
  assert.equal(parsed.result.service_execution_id, "se_mock_1");
  assert.equal(parsed.result.amount, "1.00 CNY");
  assert.equal(parsed.next.command, "itpay services next se_mock_1 --json");
  assert.doesNotMatch(stdoutCapture.join(""), /agent_guidance|capabilities|client_context|input_schema/);
  assert.equal(session.lastServiceExecutionID, "se_mock_1");

  stdoutCapture = [];
  await runCartNext(backend, session, { jsonOutput: true, output: stdoutSink });
  const next = JSON.parse(stdoutCapture.join("")) as { status: string; next: { command: string } };
  assert.equal(next.status, "action_available");
  assert.equal(next.next.command, "itpay services next se_mock_1 --json");
});

test("cart add derives Host from Agent Type and keeps output contract stable", async () => {
  const expectedHosts: Record<string, string> = {
    "codex-desktop": "codex",
    "codex-cli": "terminal",
    "claude-code-desktop": "claude-code",
    "claude-code-cli": "terminal",
    workbuddy: "plain-chat",
  };
  for (const [agentType, expectedHost] of Object.entries(expectedHosts)) {
    const result = await runCLI([
      "--agent-type", agentType,
      "cart", "add",
      "--item", "cat_service",
      "--variant", "var_service",
      "--offer", "offer_service",
      "--input", JSON.stringify({ keyword: "example" }),
      "--json",
    ], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: mkdtempSync(join(tmpdir(), `itpay-cart-add-${agentType}-`)),
    });
    const envelope = JSON.parse(result.stdout) as { status: string; result: { service_execution_id?: string }; next: { command: string } };
    assert.equal(envelope.status, "added");
    assert.equal(envelope.result.service_execution_id, "se_mock_1");
    assert.equal(envelope.next.command, `itpay --agent-type ${agentType} services next se_mock_1 --json`);
    const cartRequest = [...mock.requests].reverse().find((request) => request.method === "POST" && request.path === "/v1/carts");
    assert.equal((cartRequest?.body?.client_context as { host?: string } | undefined)?.host, expectedHost);
    assert.equal("buyer_id" in (cartRequest?.body ?? {}), false);
    assert.equal("agent_device_id" in (cartRequest?.body ?? {}), false);
    assert.equal("agent_device_id" in ((cartRequest?.body?.client_context as Record<string, unknown> | undefined) ?? {}), false);
    assert.equal(result.stderr, "");
  }
});

test("cart add local mode is explicit JSON and makes no HTTP request", async () => {
  const requestCount = mock.requests.length;
  const result = await runCLI([
    "--agent-type", "codex-desktop",
    "cart", "add",
    "--item", "local_item",
    "--variant", "local_variant",
    "--offer", "local_offer",
    "--local",
    "--json",
  ], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: mkdtempSync(join(tmpdir(), "itpay-cart-add-local-")),
  });
  const envelope = JSON.parse(result.stdout) as { status: string; instruction: string; next: { command: string } };
  assert.equal(envelope.status, "added_local");
  assert.match(envelope.instruction, /未验证目录、价格或服务合同/);
  assert.equal(envelope.next.command, "itpay --agent-type codex-desktop cart show --local");
  assert.equal(mock.requests.length, requestCount);
});

test("cart add validates identifiers, quantity and JSON object before mutation", async () => {
  const cases = [
    { args: ["cart", "add", "--json"], code: "cart_item_required" },
    { args: ["cart", "add", "--item", "i", "--variant", "v", "--offer", "o", "--quantity", "0", "--json"], code: "quantity_invalid" },
    { args: ["cart", "add", "--item", "i", "--variant", "v", "--offer", "o", "--input", "[]", "--json"], code: "cart_input_invalid" },
  ];
  for (const testCase of cases) {
    const requestCount = mock.requests.length;
    await assert.rejects(
      execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", ...testCase.args], {
        cwd: CLI_ROOT,
        env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: mkdtempSync(join(tmpdir(), "itpay-cart-add-invalid-")) },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      (error: unknown) => {
        const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
        assert.equal(envelope.error.code, testCase.code);
        return true;
      },
    );
    assert.equal(mock.requests.length, requestCount);
  }
});

test("cart next distinguishes missing, empty, generic, and service-backed carts", async () => {
  await runCartNext(backend, new CartSession("CNY"), { jsonOutput: true, output: stdoutSink });
  assert.equal(JSON.parse(stdoutCapture.join(""))?.status, "cart_handle_missing");

  stdoutCapture = [];
  const empty = new CartSession("CNY");
  empty.rememberServerCart({ cartID: "cart_empty" });
  await runCartNext(backend, empty, { jsonOutput: true, output: stdoutSink });
  const emptyEnvelope = JSON.parse(stdoutCapture.join(""));
  assert.equal(emptyEnvelope.status, "cart_empty");
  assert.equal(emptyEnvelope.next.command, "itpay catalog list --json");

  stdoutCapture = [];
  const generic = new CartSession("CNY");
  generic.rememberServerCart({ cartID: "cart_generic" });
  const genericBackend = {
    getCart: async () => ({
      cart_id: "cart_generic", status: "active", amount_minor: 300, currency: "CNY",
      items: [{ title: "Generic item", quantity: 1, amount_minor: 300, currency: "CNY" }],
    }),
  } as unknown as BackendClient;
  await runCartNext(genericBackend, generic, { jsonOutput: true, output: stdoutSink });
  const genericEnvelope = JSON.parse(stdoutCapture.join(""));
  assert.equal(genericEnvelope.result.item_count, 1);
  assert.equal(genericEnvelope.next.command, "itpay buy --cart cart_generic --json");
});

test("cart next is compact across every Agent Type and has structured stale-handle recovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-cart-next-types-"));
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_empty" });
  session.saveToFile(join(home, ".itpay-v3", "cart.json"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI(["--agent-type", agentType, "cart", "next", "--json"], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]!).status, "cart_empty");

  const staleHome = mkdtempSync(join(tmpdir(), "itpay-cli-cart-next-stale-"));
  const stale = new CartSession("CNY");
  stale.rememberServerCart({ cartID: "cart_missing" });
  stale.saveToFile(join(staleHome, ".itpay-v3", "cart.json"));
  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "cart", "next", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, HOME: staleHome, ITPAY_BACKEND_URL: mock.url },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? ""));
      assert.equal(envelope.status, "error");
      assert.equal(envelope.error.code, "not_found");
      assert.equal(envelope.recovery[0]?.command, "itpay --agent-type codex-cli services list --json");
      return true;
    },
  );
});

test("top-level next routes one local handle without emitting resource DTOs", () => {
  const session = new CartSession("CNY");
  session.rememberCheckout({
    checkoutID: "chk_1", displayToken: "cdt_1", checkoutURL: "https://example.test/checkout/chk_1",
    serviceExecutionID: "se_1",
  });
  runNext(session, { jsonOutput: true, output: stdoutSink });
  const execution = JSON.parse(stdoutCapture.join("")) as {
    status: string; result: { resource_type: string; resource_id: string }; next: { command: string };
  };
  assert.equal(execution.status, "resume_available");
  assert.deepEqual(execution.result, { resource_type: "service_execution", resource_id: "se_1" });
  assert.equal(execution.next.command, "itpay services next se_1 --json");
  assert.doesNotMatch(stdoutCapture.join(""), /capabilities|agent_guidance|next_actions/);

  stdoutCapture = [];
  const checkout = new CartSession("CNY");
  checkout.rememberCheckout({ checkoutID: "chk_2", displayToken: "cdt_2", checkoutURL: "https://example.test/checkout/chk_2" });
  runNext(checkout, { jsonOutput: true, output: stdoutSink });
  assert.equal(JSON.parse(stdoutCapture.join(""))?.next?.command, "itpay checkout --id chk_2 --token cdt_2 --json");

  stdoutCapture = [];
  const cart = new CartSession("CNY");
  cart.rememberServerCart({ cartID: "cart_3" });
  runNext(cart, { jsonOutput: true, output: stdoutSink });
  assert.equal(JSON.parse(stdoutCapture.join(""))?.next?.command, "itpay cart next --json");

  stdoutCapture = [];
  runNext(new CartSession("CNY"), { jsonOutput: true, output: stdoutSink });
  assert.equal(JSON.parse(stdoutCapture.join(""))?.status, "nothing_to_resume");
});

test("top-level next recovers corrupt local state through the server", () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-next-corrupt-"));
  const path = join(home, "cart.json");
  writeFileSync(path, "{not-json", "utf8");
  const session = CartSession.loadFromFile(path, "CNY");
  runNext(session, { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as { status: string; next: { command: string } };
  assert.equal(envelope.status, "local_state_invalid");
  assert.equal(envelope.next.command, "itpay services list --json");
});

test("top-level next keeps facts stable and preserves every Agent Type", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-next-types-"));
  const session = new CartSession("CNY");
  session.rememberCheckout({
    checkoutID: "chk_types", displayToken: "cdt_types", checkoutURL: "https://example.test/checkout/chk_types",
    serviceExecutionID: "se_types",
  });
  session.saveToFile(join(home, ".itpay-v3", "cart.json"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI(["--agent-type", agentType, "next", "--json"], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]!).next.command, "itpay services next se_types --json");
});

test("services next returns one compact current-state action", async () => {
  await runServicesNext(backend, "se_mock_next", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { service_execution_id: string; phase: string };
    next: { command: string };
  };
  assert.equal(envelope.status, "running");
  assert.equal(envelope.result.service_execution_id, "se_mock_next");
  assert.equal(envelope.result.phase, "pre_purchase");
  assert.match(envelope.next.command, /fuzzy_disambiguation/);
  assert.doesNotMatch(stdoutCapture.join(""), /capabilities|agent_guidance|stable_hash/);
});

test("services next restores candidate items on the source execution", async () => {
	await runServicesInvoke(backend, config, "se_candidate_recovery", "fuzzy_disambiguation", { keyword: "小米" }, { output: silent });
	await runServicesNext(backend, "se_candidate_recovery", { jsonOutput: true, output: stdoutSink });
	const envelope = JSON.parse(stdoutCapture.join("")) as {
		status: string;
		result: { service_execution_id: string; items: Array<{ rank: number; title: string; safe_payload: Record<string, unknown> }> };
		instruction: string;
		next: { command: string };
	};
	assert.equal(envelope.status, "candidate_selection_available");
	assert.equal(envelope.result.service_execution_id, "se_candidate_recovery");
	assert.deepEqual(envelope.result.items[0], {
		rank: 1,
		title: "小米汽车科技有限公司",
		safe_payload: { company_name: "小米汽车科技有限公司" },
	});
	assert.match(envelope.instruction, /候选列表已满足用户目标，在此停止/);
	assert.match(envelope.next.command, /services action se_candidate_recovery/);
	assert.doesNotMatch(stdoutCapture.join(""), /service_capability_result_item_id|stable_hash|invocation/);
});

test("services next exposes only safe agent-visible result fields", async () => {
  await runServicesNext(backend, "se_agent_visible", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { delivery_mode: string; items: Array<{ safe_payload: Record<string, unknown> }> };
    next: unknown;
  };
  assert.equal(envelope.status, "result_ready");
  assert.equal(envelope.result.delivery_mode, "agent_visible_result");
  assert.deepEqual(envelope.result.items[0]?.safe_payload, { name: "Example result", status: "active" });
  assert.equal(envelope.next, null);
  assert.doesNotMatch(stdoutCapture.join(""), /stable_hash|service_capability_result_item_id/);
});

test("services next keeps Vault payload hidden until human authorization", async () => {
  await runServicesNext(backend, "se_vault_none", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { delivery_mode: string; grant_status: string; payload?: unknown; items?: unknown };
    next: { command: string };
  };
  assert.equal(envelope.status, "human_authorization_required");
  assert.equal(envelope.result.delivery_mode, "vault_artifact");
  assert.equal(envelope.result.grant_status, "none");
  assert.equal(envelope.result.payload, undefined);
  assert.equal(envelope.result.items, undefined);
  assert.match(envelope.next.command, /services read-result se_vault_none --json/);
});

test("services next recommends immediate read only for an active grant", async () => {
  await runServicesNext(backend, "se_granted", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { grant_status: string; grant_expires_at: string };
    next: { command: string };
  };
  assert.equal(envelope.status, "grant_active");
  assert.equal(envelope.result.grant_status, "active");
  assert.equal(envelope.result.grant_expires_at, "2026-07-13T12:15:00Z");
  assert.equal(envelope.next.command, "itpay services read-result se_granted --json");
});

test("services next uses the current Vault delivery after an older agent-visible delivery", async () => {
	const model = await backend.getServiceExecution("se_granted");
	model.delivery_bindings.unshift({
		service_delivery_binding_id: "sdb_old",
		service_execution_id: "se_granted",
		order_id: "ord_old",
		status: "completed",
		redacted_summary: { delivery_mode: "agent_visible_result" },
	});
	model.current_delivery = model.delivery_bindings.at(-1)!;
	const currentBackend = { getServiceExecution: async () => model } as unknown as BackendClient;

	await runServicesNext(currentBackend, "se_granted", { jsonOutput: true, output: stdoutSink });
	const envelope = JSON.parse(stdoutCapture.join("")) as { status: string; next: { command: string } };
	assert.equal(envelope.status, "grant_active");
	assert.equal(envelope.next.command, "itpay services read-result se_granted --json");
});

test("refund lock takes precedence over delivery guidance", async () => {
  await runServicesNext(backend, "se_refund_locked", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { access_locked: boolean; refund: { refund_request_id: string } };
    next: { command: string };
  };
  assert.equal(envelope.status, "delivery_locked");
  assert.equal(envelope.result.access_locked, true);
  assert.equal(envelope.result.refund.refund_request_id, "rr_locked");
  assert.equal(envelope.next.command, "itpay refund get rr_locked --json");

});

test("refund-locked delivery keeps facts stable and preserves every Agent Type", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-locked-delivery-"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI([
      "--agent-type", agentType, "services", "next", "se_refund_locked", "--json",
    ], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]!).status, "delivery_locked");
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
    status: string;
    result: { checkout: { capability_id: string; price: { amount_minor: number; currency: string } } };
    next: { command: string; reason: string };
  };
  assert.equal(parsed.status, "quota_exhausted");
  assert.equal(parsed.result.checkout.capability_id, "fuzzy_disambiguation_paid");
  assert.deepEqual(parsed.result.checkout.price, { amount_minor: 10, currency: "CNY" });
  assert.equal(
    parsed.next.command,
		"itpay services checkout se_quota --capability fuzzy_disambiguation_paid --input keyword=美团 --json",
  );
	assert.equal(parsed.next.reason, "仅在用户明确同意支付 0.10 CNY 后执行；否则停止");
	assert.match(stdoutCapture.join(""), /然后停止并等待用户明确回复/);
	assert.match(stdoutCapture.join(""), /不要尝试其他 capability、quote、cart、buy、checkout 或 pay 命令/);
  const requests = mock.requests.filter((request) => request.path.includes("/v1/service-executions/se_quota"));
	assert.equal(requests.at(-2)?.method, "GET");
	assert.equal(requests.at(-1)?.method, "POST");
});

test("services invoke rejects paid capabilities and returns only same-execution recovery", async () => {
	const requestsBefore = mock.requests.length;
	await assert.rejects(
		runServicesInvoke(
			backend,
			config,
			"se_paid_direct",
			"precise_lookup",
			{ company: "example" },
			{ jsonOutput: true, output: stdoutSink },
		),
		(error: unknown) => {
			assert.ok(error instanceof CommandContractError);
			assert.equal(error.code, "checkout_required");
			assert.match(error.instruction, /不要尝试 quote、cart、buy、checkout 或 pay 作为旁路/);
			assert.equal(
				error.recovery[0]?.command,
					"itpay services next se_paid_direct --json",
			);
			assert.equal(error.recovery.length, 1);
			return true;
		},
	);
	const requests = mock.requests.slice(requestsBefore).filter((request) => request.path.includes("/v1/service-executions/se_paid_direct"));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.method, "GET");
});

test("independent service quotes aggregate into one cart and one checkout", async () => {
	const quoteIDs: string[] = [];
	for (const executionID of ["se_bundle_a", "se_bundle_b"]) {
		stdoutCapture = [];
		await runServicesQuote(backend, executionID, "precise_report", {}, {
			email: "buyer@example.com", jsonOutput: true, output: stdoutSink,
		});
		const envelope = JSON.parse(stdoutCapture.join("")) as {
			status: string;
			result: { service_quote_lock_id: string };
			next: { command: string };
		};
		assert.equal(envelope.status, "quote_ready");
		assert.match(envelope.next.command, /^itpay cart add --quote /);
		quoteIDs.push(envelope.result.service_quote_lock_id);
	}

	const session = new CartSession("CNY");
	for (const quoteID of quoteIDs) {
		await runCartAddQuoteServer({
			serviceQuoteLockID: quoteID, host: "codex", backend, config, session, output: silent,
		});
	}
	const cart = await backend.getCart(session.lastCartID!);
	assert.equal(cart.items.length, 2);
	assert.deepEqual(cart.items.map((item) => item.service_execution_id), ["se_bundle_a", "se_bundle_b"]);
	assert.ok(cart.items.every((item) => Boolean(item.service_quote_lock_id)));

	stdoutCapture = [];
	await runBuy(backend, config, {
		cartSession: session, cartID: cart.cart_id, host: "codex", jsonOutput: true, output: stdoutSink,
	});
	const checkoutRequests = mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/checkouts");
	assert.equal(checkoutRequests.length, 1);
	assert.equal(checkoutRequests[0]?.body?.cart_id, cart.cart_id);
});

test("services invoke validates required input before the provider request", async () => {
	const requestsBefore = mock.requests.length;
	await assert.rejects(
		runServicesInvoke(
			backend,
			config,
			"se_missing_input",
			"fuzzy_disambiguation",
			{},
			{ jsonOutput: true, output: stdoutSink },
		),
		(error: unknown) => {
			assert.ok(error instanceof CommandContractError);
			assert.equal(error.code, "capability_input_invalid");
			assert.match(error.recovery[0]?.command ?? "", /--input keyword=<value>/);
			return true;
		},
	);
	const requests = mock.requests.slice(requestsBefore).filter((request) => request.path.includes("se_missing_input"));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.method, "GET");
});

test("services invoke returns only safe result items and one next action", async () => {
	await runServicesInvoke(
		backend,
		config,
		"se_result",
		"fuzzy_disambiguation",
		{ keyword: "小米" },
		{ jsonOutput: true, output: stdoutSink },
	);
	const parsed = JSON.parse(stdoutCapture.join(""));
	assert.equal(parsed.status, "result_ready");
	assert.equal(parsed.result.items[0].title, "小米汽车科技有限公司");
	assert.match(parsed.next.command, /^itpay services action se_result /);
	assert.equal("execution" in parsed, false);
	assert.equal("invocation" in parsed, false);
	assert.equal("agent_guidance" in parsed, false);
});

test("services list recovers executions without a local cart handle", async () => {
  await backend.startServiceExecution({ service_id: "svc_qizhidao_company_lookup" });
  await runServicesList(backend, { jsonOutput: true, output: stdoutSink });
  assert.equal(mock.requests.at(-1)?.path, "/v1/service-executions?limit=10");
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { executions: Array<Record<string, unknown>> };
    next: { command: string };
  };
  assert.equal(envelope.status, "listed");
  const firstID = String(envelope.result.executions[0]?.service_execution_id);
  assert.match(firstID, /^se_/);
  assert.equal(envelope.next.command, `itpay services next ${firstID} --json`);
  assert.deepEqual(Object.keys(envelope.result.executions[0] ?? {}), [
    "service_execution_id", "service_id", "status", "phase", "updated_at",
  ]);
  assert.doesNotMatch(stdoutCapture.join(""), /capabilities|agent_guidance|result_items|client_context/);
});

test("services list validates limit and handles an empty server list", async () => {
  const before = mock.requests.length;
  await assert.rejects(
    runServicesList(backend, { limit: 0, jsonOutput: true, output: silent }),
    (error: unknown) => error instanceof CommandContractError && error.code === "limit_invalid",
  );
  assert.equal(mock.requests.length, before);

  const emptyBackend = { listServiceExecutions: async () => ({ executions: [] }) } as unknown as BackendClient;
  await runServicesList(emptyBackend, { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as { status: string; next: { command: string } };
  assert.equal(envelope.status, "no_executions");
  assert.equal(envelope.next.command, "itpay catalog list --json");
});

test("services list is compact, fact-stable, and preserves every Agent Type", async () => {
  await backend.startServiceExecution({ service_id: "svc_qizhidao_company_lookup" });
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-services-list-types-"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI([
      "--agent-type", agentType, "services", "list", "--limit", "1", "--json",
    ], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]!).status, "listed");
});

test("services get returns a bounded public timeline", async () => {
  await runServicesGet(backend, "se_timeline", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { timeline: Array<{ sequence: number; step: string }>; timeline_truncated: boolean };
    next: { command: string };
    recovery: Array<{ command: string }>;
  };
  assert.equal(envelope.status, "shown");
  assert.equal(envelope.result.timeline.length, 20);
  assert.equal(envelope.result.timeline[0]?.sequence, 6);
  assert.equal(envelope.result.timeline.at(-1)?.step, "delivery.issued");
  assert.equal(envelope.result.timeline_truncated, true);
  assert.match(envelope.next.command, /services invoke se_timeline/);
  assert.equal(envelope.recovery[0]?.command, "itpay services events se_timeline --json");
  assert.doesNotMatch(stdoutCapture.join(""), /must_not_leak|service_execution_event_id|graph_projection|capabilities/);
});

test("services get keeps facts stable across Agent Types and keeps not-found opaque", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-services-get-types-"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI([
      "--agent-type", agentType, "services", "get", "se_timeline", "--json",
    ], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);

  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "services", "get", "se_missing", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, HOME: home, ITPAY_BACKEND_URL: mock.url },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? ""));
      assert.equal(envelope.error.code, "not_found");
      assert.equal(envelope.recovery[0]?.command, "itpay --agent-type codex-cli services list --json");
      return true;
    },
  );
});

test("services events returns bounded public facts and strips event internals", async () => {
  await runServicesEvents(backend, "se_events", {
    afterSequence: 1,
    limit: 2,
    jsonOutput: true,
    output: stdoutSink,
  });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: {
      service_execution_id: string;
      after_sequence: number;
      returned_count: number;
      events: Array<Record<string, unknown>>;
    };
    next: { command: string };
    recovery: Array<{ command: string }>;
  };
  assert.equal(envelope.status, "listed");
  assert.equal(envelope.result.after_sequence, 1);
  assert.equal(envelope.result.returned_count, 2);
  assert.deepEqual(Object.keys(envelope.result.events[0] ?? {}), [
    "sequence", "type", "status", "phase", "capability_id", "occurred_at",
  ]);
  assert.equal(envelope.next.command, "itpay services next se_events --json");
  assert.equal(envelope.recovery[0]?.command, "itpay services events se_events --after-sequence 3 --limit 2 --json");
  assert.doesNotMatch(stdoutCapture.join(""), /see_secret|must_not_leak|redacted_summary|provider_header|selected_candidate_hash/);
});

test("services events keeps facts stable across Agent Types and validates before HTTP", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-service-events-types-"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI([
      "--agent-type", agentType, "services", "events", "se_events", "--after-sequence", "0", "--limit", "3", "--json",
    ], { HOME: home, ITPAY_BACKEND_URL: mock.url });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);

  const before = mock.requests.length;
  await assert.rejects(
    runCLI(["--agent-type", "codex-cli", "services", "events", "se_events", "--limit", "101", "--json"], {
      HOME: home,
      ITPAY_BACKEND_URL: mock.url,
    }),
    (error: unknown) => {
      const failure = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(failure.error.code, "events_parameter_invalid");
      return true;
    },
  );
  assert.equal(mock.requests.length, before);
});

test("terminal service executions never recommend replaying a capability", async () => {
  const terminalModel: ServiceExecutionReadModel = {
    execution: {
      service_execution_id: "se_cancelled", service_id: "svc_generic", service_contract_version_id: "scv_1",
      status: "cancelled", phase: "failed", current_capability_id: "generic_capability",
      checkout_required: false, next_action: "invoke_capability", started_at: "2026-07-13T00:00:00Z",
      created_at: "2026-07-13T00:00:00Z", updated_at: "2026-07-13T00:01:00Z",
    },
    capabilities: [{
      capability_id: "generic_capability", phase: "pre_purchase", agent_visible: true,
      requires_payment: false, requires_human_action: false, vault_required: false,
      delivery_email_required: false,
    }],
    events: [], result_items: [], actions: [], checkout_bindings: [], payment_bindings: [],
    execution_requests: [], provider_invocations: [], delivery_bindings: [], refunds: [],
  };
  const guidance = buildServiceReadModelGuidance(terminalModel);
  assert.equal(guidance.next_actions.length, 0);

  const terminalBackend = {
    getServiceExecution: async () => terminalModel,
  } as unknown as BackendClient;
  stdoutCapture = [];
  await runServicesNext(terminalBackend, "se_cancelled", { jsonOutput: true, output: stdoutSink });
  const next = JSON.parse(stdoutCapture.join("")) as { status: string; next: unknown; recovery: Array<{ command: string }> };
  assert.equal(next.status, "cancelled");
  assert.equal(next.next, null);
  assert.equal(next.recovery[0]?.command, "itpay services events se_cancelled --json");

  stdoutCapture = [];
  await runServicesGet(terminalBackend, "se_cancelled", { jsonOutput: true, output: stdoutSink });
  const shown = JSON.parse(stdoutCapture.join("")) as { next: unknown; instruction: string };
  assert.equal(shown.next, null);
  assert.match(shown.instruction, /已结束/);
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

test("agent-visible delivery exposes complete safe fields and never recommends Vault read-result", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_paid_fuzzy", service_id: "svc_company", service_contract_version_id: "scv_1",
      status: "completed", phase: "completed", checkout_required: false, next_action: "completed",
      started_at: "2026-07-12T00:00:00Z", created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:00Z",
    },
    capabilities: [], events: [], actions: [], checkout_bindings: [], payment_bindings: [], execution_requests: [], provider_invocations: [], refunds: [],
    result_items: [{
      service_capability_result_item_id: "sri_1", service_execution_id: "se_paid_fuzzy", capability_id: "fuzzy_disambiguation_paid",
		rank: 1, display_title: "北京京东世纪贸易有限公司",
      safe_payload: { company_name: "北京京东世纪贸易有限公司", status: "存续", region: "北京", credit_code: "911103026605015136" },
      created_at: "2026-07-12T00:00:00Z",
    }],
    delivery_bindings: [{
      service_delivery_binding_id: "sdb_1", service_execution_id: "se_paid_fuzzy", order_id: "ord_1", status: "completed",
      redacted_summary: { delivery_mode: "agent_visible_result", result_item_count: 1 },
    }],
  });
  assert.equal(guidance.next_actions[0]?.id, "use_agent_visible_result");
  assert.doesNotMatch(guidance.next_actions[0]?.command ?? "", /read-result/);
  assert.deepEqual(guidance.visible_results?.[0]?.safe_payload, {
    company_name: "北京京东世纪贸易有限公司", status: "存续", region: "北京", credit_code: "911103026605015136",
  });
});

test("services read-result delegates current grant authorization to the Vault endpoint", async () => {
  let grantedResultCalled = false;
  const currentGrantBackend = {
    getGrantedServiceResult: async () => {
      grantedResultCalled = true;
      return {
			service_execution_id: "se_multi_delivery",
			vault_artifact_id: "vault_current",
			agent_read_grant_id: "grant_current",
			grant_status: "active",
			result: { summary: "granted" },
		};
    },
  } as unknown as BackendClient;
  await runServicesReadResult(currentGrantBackend, "se_multi_delivery", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as { status: string; result: { payload: Record<string, unknown> } };
  assert.equal(grantedResultCalled, true);
  assert.equal(envelope.status, "granted_result_ready");
  assert.deepEqual(envelope.result.payload, { summary: "granted" });
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
  assert.equal(guidance.next_actions[1]?.command, "itpay services start svc_qizhidao_company_lookup");
});

test("empty lookup starts a new execution instead of reusing a closed one", () => {
  const guidance = buildServiceReadModelGuidance({
    execution: {
      service_execution_id: "se_empty", service_id: "svc_company", service_contract_version_id: "scv_1",
      status: "human_action_required", phase: "pre_purchase", current_capability_id: "fuzzy_disambiguation",
      checkout_required: false, next_action: "select_candidate", started_at: "2026-07-12T00:00:00Z",
      created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:00Z",
    },
    capabilities: [], events: [], actions: [], checkout_bindings: [], payment_bindings: [], execution_requests: [], refunds: [],
    result_items: [], delivery_bindings: [],
    provider_invocations: [{
      service_capability_invocation_id: "sci_empty", service_execution_id: "se_empty", capability_id: "fuzzy_disambiguation",
      status: "succeeded", created_at: "2026-07-12T00:00:00Z",
    }],
  });
  assert.equal(guidance.next_actions[0]?.command, "itpay services start svc_company");
  assert.doesNotMatch(guidance.next_actions[0]?.command ?? "", /services invoke/);
});

test("service recovery guides backend outage retries", () => {
  const recovery = errorRecoveryActions(new HttpError(503, { code: "unavailable", message: "backend unavailable" }, "HTTP 503"));
  assert.equal(recovery[0]?.command, "itpay readyz");
  assert.equal(recovery[1]?.command, "echo $ITPAY_BACKEND_URL");
});

test("cart show returns an explicit local draft contract", () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  runCartShow(session, { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { items: Array<{ catalog_variant_id: string }> };
    next: { command: string };
  };
  assert.equal(envelope.status, "shown_local");
  assert.equal(envelope.result.items[0]?.catalog_variant_id, "v_1");
  assert.equal(envelope.next.command, "itpay buy --json");
});

test("canonical cart show is compact and does not read Service Execution", async () => {
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
    output: silent,
  });
  mock.requests.length = 0;
  await runCartShowServer(backend, session, { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { items: Array<Record<string, unknown>> };
    next: { command: string };
  };
  assert.equal(envelope.status, "shown");
  assert.deepEqual(envelope.result.items, [{
    cart_item_id: "ci_1",
    title: "企知道企业查询",
    quantity: 1,
    service_execution_id: "se_mock_1",
  }]);
  assert.equal(envelope.next.command, "itpay cart next --json");
  assert.doesNotMatch(stdoutCapture.join(""), /offer_id|catalog_variant_id|service_quote_lock|agent_guidance|capabilities/);
  assert.deepEqual(mock.requests.map((request) => `${request.method} ${request.path}`), [`GET /v1/carts/${session.lastCartID}`]);
});

test("cart show keeps facts stable and preserves Agent Type in canonical and local JSON", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cart-show-types-"));
  const session = new CartSession("CNY");
  session.rememberServerCart({ cartID: "cart_show_types" });
  session.saveToFile(join(home, ".itpay-v3", "cart.json"));
  const outputs: string[] = [];
  for (const agentType of AGENT_TYPES) {
    const result = await runCLI(["--agent-type", agentType, "cart", "show", "--json"], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: home,
    });
    assertQualifiedAgentType(result.stdout, agentType);
    outputs.push(withoutQualifiedAgentType(result.stdout));
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  assert.equal(JSON.parse(outputs[0]!).status, "shown");

  const localHome = mkdtempSync(join(tmpdir(), "itpay-cart-show-local-"));
  const local = new CartSession("CNY");
  runCartAdd(local, { catalogItemID: "i", catalogVariantID: "v", offerID: "o", quantity: 1, output: silent });
  local.saveToFile(join(localHome, ".itpay-v3", "cart.json"));
  const localResult = await runCLI(["--agent-type", "workbuddy", "cart", "show", "--local", "--json"], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: localHome,
  });
  assert.equal(JSON.parse(localResult.stdout).status, "shown_local");
});

test("cart show keeps missing and stale canonical handles recoverable", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "itpay-cart-show-missing-"));
  const missing = await runCLI(["--agent-type", "codex-cli", "cart", "show", "--json"], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: emptyHome,
  });
  const missingEnvelope = JSON.parse(missing.stdout) as { status: string; recovery: Array<{ command: string }> };
  assert.equal(missingEnvelope.status, "cart_handle_missing");
  assert.equal(missingEnvelope.recovery[0]?.command, "itpay --agent-type codex-cli cart show --local --json");

  const staleHome = mkdtempSync(join(tmpdir(), "itpay-cart-show-stale-"));
  const stale = new CartSession("CNY");
  stale.rememberServerCart({ cartID: "cart_missing" });
  stale.saveToFile(join(staleHome, ".itpay-v3", "cart.json"));
  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "cart", "show", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: staleHome },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "not_found");
      return true;
    },
  );
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
  assert.equal(persisted.lastCartID, undefined);
  assert.equal(persisted.lastCheckoutID, "chk_session");
  assert.equal(persisted.lastDisplayToken, "cdt_session");
  assert.equal(persisted.lastCheckoutURL, "https://sandbox.itpay.ai/checkout/chk_session?display_token=cdt_session");
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const loaded = CartSession.loadFromFile(path, "CNY").show();
  assert.deepEqual(loaded.items, []);
  assert.equal(loaded.lastCartID, undefined);
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
  assert.match(snap.lastCheckoutID ?? "", /^chk_\d+$/);
  assert.ok(snap.lastDisplayToken);
  assert.match(snap.lastCheckoutURL ?? "", new RegExp(`/checkout/${snap.lastCheckoutID}\\?`));
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

test("runBuy rejects missing contact before checkout with explicit recovery", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_1",
    catalogVariantID: "v_1",
    offerID: "o_1",
    quantity: 1,
    output: silent,
  });
  await assert.rejects(
    runBuy(backend, config, {
      cartSession: session,
      host: "codex",
      requiredContactFields: ["email", "phone"],
      output: stdoutSink,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommandContractError);
      assert.equal(error.code, "missing_contact");
      assert.match(error.instruction, /禁止编造/);
      return true;
    },
  );
  assert.equal(mock.requests.length, 0);
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
    (error: unknown) => {
      assert.ok(error instanceof CommandContractError);
      assert.equal(error.code, "cart_empty");
      assert.equal(error.recovery[0]?.command, "itpay catalog list --json");
      return true;
    },
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
  await runReadyz(backend, { output: stdoutSink, jsonOutput: true });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/readyz");
  assert.deepEqual(JSON.parse(stdoutCapture.join("")), {
    status: "ready",
    result: { backend: "available" },
    instruction: "ItPay 可用；先完整读取内置 Buyer Skill，再开始服务流程。",
    next: { command: "itpay skill show itpay-buyer --json", reason: "加载完整操作与安全规则" },
    recovery: [],
  });
});

test("readyz command supports the documented JSON contract", async () => {
  const result = await runCLI(["readyz", "--json"], { ITPAY_BACKEND_URL: mock.url });
  assert.equal(JSON.parse(result.stdout).status, "ready");
  assert.equal(result.stderr, "");
});

test("CLI fails closed when the Backend compatibility contract is unavailable", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: "platform_release_unavailable", message: "active platform release is unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await assert.rejects(
      runCLI(["--agent-type", "workbuddy", "readyz", "--json"], {
        ITPAY_BACKEND_URL: `http://127.0.0.1:${address.port}`,
      }),
      (error: unknown) => {
        const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
          error: { code: string };
          instruction: string;
          next: unknown;
          recovery: unknown[];
        };
        assert.equal(envelope.error.code, "backend_contract_incompatible");
        assert.match(envelope.instruction, /立即向用户报告 error.message 并结束本次任务/);
        assert.match(envelope.instruction, /不要运行任何其他 itpay、npm、which、device、docs、cart、orders 或 services 命令/);
        assert.equal(envelope.next, null);
        assert.deepEqual(envelope.recovery, []);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("readyz, catalog, and top-level next fail before guidance when the contract hash differs", async () => {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/platform/compatibility") {
      response.end(JSON.stringify({
        platform_revision: "v3.contract-mismatch",
        schema_revision: "sha256:schema",
        bootstrap_revision: "seed",
        api_contract_revision: "sha256:old-contract",
        minimum_cli_version: "2.0.8",
        maximum_cli_major: 2,
      }));
      return;
    }
    response.end(JSON.stringify({ status: "unexpected" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    for (const args of [["readyz", "--json"], ["catalog", "list", "--json"], ["next", "--json"]]) {
      requests.length = 0;
      const home = mkdtempSync(join(tmpdir(), "itpay-contract-stop-"));
      await assert.rejects(
        runCLI(args, { HOME: home, ITPAY_BACKEND_URL: `http://127.0.0.1:${address.port}` }),
        (error: unknown) => {
          const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
            error: { code: string; message: string };
            instruction: string;
            next: unknown;
            recovery: unknown[];
          };
          assert.equal(envelope.error.code, "backend_contract_incompatible");
          assert.match(envelope.error.message, /sha256:old-contract/);
          assert.match(envelope.instruction, /不要运行任何其他 itpay/);
          assert.equal(envelope.next, null);
          assert.deepEqual(envelope.recovery, []);
          return true;
        },
      );
      assert.deepEqual(requests, ["/v1/platform/compatibility"]);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("CLI stops on Backend internal errors without identity or paid-path recovery", async () => {
  mock.setServiceError({ status: 500, code: "internal_error", message: "request failed" });
  try {
    await assert.rejects(
      runCLI(["--agent-type", "workbuddy", "services", "list", "--json"], {
        ITPAY_BACKEND_URL: mock.url,
      }),
      (error: unknown) => {
        const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
          error: { code: string };
          instruction: string;
          next: unknown;
          recovery: unknown[];
        };
        assert.equal(envelope.error.code, "internal_error");
        assert.match(envelope.instruction, /Backend 内部故障；立即停止/);
        assert.match(envelope.instruction, /不要重试、检查或删除 Device 身份/);
        assert.match(envelope.instruction, /不要.*切换 Backend/);
        assert.match(envelope.instruction, /quote、checkout、cart、buy、pay/);
        assert.equal(envelope.next, null);
        assert.deepEqual(envelope.recovery, []);
        return true;
      },
    );
  } finally {
    mock.setServiceError();
  }
});

test("ITPAY_AGENT_TYPE is preserved in generated commands", async () => {
  const result = await runCLI(["readyz", "--json"], {
    ITPAY_BACKEND_URL: mock.url,
    ITPAY_AGENT_TYPE: "claude-code-cli",
  });
  const envelope = JSON.parse(result.stdout) as { result: { agent_type: string }; next: { command: string } };
  assert.equal(envelope.result.agent_type, "claude-code-cli");
  assert.equal(envelope.next.command, "itpay --agent-type claude-code-cli skill show itpay-buyer --json");
});

test("device recover requires confirmation and remains Backend-scoped", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-device-recover-cli-"));
  await assert.rejects(
    runCLI(["--agent-type", "workbuddy", "device", "recover", "--json"], {
      HOME: home,
      ITPAY_BACKEND_URL: "https://dev.itpay.ai",
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "backend_reset_confirmation_required");
      return true;
    },
  );

  const envelope = JSON.parse((await runCLI([
    "--agent-type", "workbuddy", "device", "recover", "--confirm-backend-reset", "--json",
  ], {
    HOME: home,
    ITPAY_BACKEND_URL: "https://dev.itpay.ai",
  })).stdout) as {
    status: string;
    result: { backend: string; private_key_preserved: boolean; other_backend_registrations_preserved: boolean };
    next: { command: string };
  };
  assert.equal(envelope.status, "backend_registration_absent");
  assert.equal(envelope.result.backend, "https://dev.itpay.ai");
  assert.equal(envelope.result.private_key_preserved, true);
  assert.equal(envelope.result.other_backend_registrations_preserved, true);
  assert.equal(envelope.next.command, "itpay --agent-type workbuddy services list --limit 1 --json");
});

test("skill show returns the complete packaged Skill and type-aware onboarding", async () => {
  const untyped = JSON.parse((await runCLI(["skill", "show", "itpay-buyer", "--json"], {})).stdout) as {
    status: string; result: { skill: string; content: string }; next: { command: string };
  };
  assert.equal(untyped.status, "shown");
  assert.equal(untyped.result.skill, "itpay-buyer");
  assert.match(untyped.result.content, /## Identity And Sessions/);
  assert.equal(untyped.next.command, "itpay install --json");

  const typed = JSON.parse((await runCLI([
    "--agent-type", "codex-desktop", "skill", "show", "itpay-buyer", "--json",
  ], {})).stdout) as { next: { command: string }; instruction: string };
  assert.equal(typed.next.command, "itpay --agent-type codex-desktop catalog list --json");
  assert.match(typed.instruction, /codex-desktop/);

  const workbuddy = JSON.parse((await runCLI([
    "--agent-type", "workbuddy", "skill", "show", "itpay-buyer", "--json",
  ], {})).stdout) as typeof typed;
  assert.deepEqual(Object.keys(workbuddy).sort(), Object.keys(typed).sort());
  assert.equal(workbuddy.next.command, "itpay --agent-type workbuddy catalog list --json");
  assert.match(workbuddy.instruction, /同一 Node\/CLI launcher/);
});

test("skill show rejects unknown or damaged packaged skills with bounded recovery", async () => {
  await assert.rejects(
    runCLI(["skill", "show", "missing", "--json"], {}),
    (error: unknown) => {
      const failure = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
        error: { code: string }; recovery: Array<{ command: string }>;
      };
      assert.equal(failure.error.code, "skill_not_found");
      assert.equal(failure.recovery[0]?.command, "itpay skill show itpay-buyer --json");
      return true;
    },
  );
  const skillsDir = mkdtempSync(join(tmpdir(), "itpay-skills-invalid-"));
  mkdirSync(join(skillsDir, "itpay-buyer"));
  writeFileSync(join(skillsDir, "itpay-buyer", "SKILL.md"), "broken", "utf8");
  await assert.rejects(
    runCLI(["skill", "show", "itpay-buyer", "--json"], { ITPAY_CLI_SKILLS_DIR: skillsDir }),
    (error: unknown) => {
      const failure = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(failure.error.code, "skill_unavailable");
      return true;
    },
  );
});

test("install returns one official contract for every supported Agent Type", async () => {
  const expectedHosts: Record<string, string> = {
    "codex-desktop": "codex",
    "codex-cli": "terminal",
    "claude-code-desktop": "claude-code",
    "claude-code-cli": "terminal",
    workbuddy: "plain-chat",
  };
  for (const [agentType, defaultHost] of Object.entries(expectedHosts)) {
    const result = await runCLI(["install", agentType, "--json"], {
      HOME: mkdtempSync(join(tmpdir(), `itpay-install-${agentType}-`)),
    });
    const envelope = JSON.parse(result.stdout) as {
      status: string;
      result: { agent_type: string; default_host: string; default_api: string; install_command: string };
      instruction: string;
      next: { command: string };
    };
    assert.equal(envelope.status, "instructions_ready");
    assert.deepEqual(envelope.result, {
      agent_type: agentType,
      default_host: defaultHost,
      default_api: DEFAULT_BASE_URL,
      install_command: "npm install -g @itpay/cli",
    });
    assert.match(envelope.instruction, /始终传这个 Agent Type/);
    if (agentType === "workbuddy") {
      assert.match(envelope.instruction, /present_files/);
      assert.match(envelope.instruction, /不要检查本地二维码文件/);
    }
    assert.equal(envelope.next.command, `itpay --agent-type ${agentType} readyz --json`);
    assert.equal(result.stderr, "");
  }
});

test("install lists supported types and rejects obsolete Host targets", async () => {
  const listed = await runCLI(["install", "--json"], {
    HOME: mkdtempSync(join(tmpdir(), "itpay-install-list-")),
  });
  const listEnvelope = JSON.parse(listed.stdout) as {
    status: string;
    result: { agent_types: Array<{ agent_type: string; default_host: string }> };
  };
  assert.equal(listEnvelope.status, "install_targets");
  assert.deepEqual(listEnvelope.result.agent_types.map((item) => item.agent_type), [
    "codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy",
  ]);

  await assert.rejects(
    runCLI(["install", "codex", "--json"], {
      HOME: mkdtempSync(join(tmpdir(), "itpay-install-invalid-")),
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
        error: { code: string };
        recovery: Array<{ command: string }>;
      };
      assert.equal(envelope.error.code, "unsupported_agent_type");
      assert.equal(envelope.recovery[0]?.command, "itpay install --json");
      return true;
    },
  );
});

test("docs list is compact, sorted and identical across Agent Types", async () => {
  const outputs: string[] = [];
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const result = await runCLI(["--agent-type", agentType, "docs", "list", "--json"], {});
    outputs.push(result.stdout);
    assert.equal(result.stderr, "");
  }
  assert.equal(new Set(outputs).size, 1);
  const envelope = JSON.parse(outputs[0]!) as {
    status: string;
    result: { topics: Array<Record<string, unknown>> };
    next: null;
  };
  assert.equal(envelope.status, "listed");
  assert.equal(envelope.next, null);
  assert.deepEqual(Object.keys(envelope.result.topics[0] ?? {}), ["topic", "title", "purpose"]);
  const names = envelope.result.topics.map((topic) => String(topic.topic));
  assert.deepEqual(names, [...names].sort());
});

test("docs show returns only one complete topic with structured recovery", async () => {
  const shown = await runCLI(["docs", "show", "quickstart", "--json"], {});
  const envelope = JSON.parse(shown.stdout) as {
    status: string;
    result: { topic: string; content: { topic: string; title: string } };
    next: null;
  };
  assert.equal(envelope.status, "shown");
  assert.equal(envelope.result.topic, "quickstart");
  assert.equal(envelope.result.content.topic, "quickstart");
  assert.equal(envelope.next, null);

  await assert.rejects(
    runCLI(["docs", "show", "missing-topic", "--json"], {}),
    (error: unknown) => {
      const failure = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
        error: { code: string };
        recovery: Array<{ command: string }>;
      };
      assert.equal(failure.error.code, "doc_not_found");
      assert.deepEqual(failure.recovery.map((item) => item.command), [
        "itpay docs list --json",
        "itpay docs search missing-topic --json",
      ]);
      return true;
    },
  );
});

test("docs search distinguishes unique, multiple and empty results", async () => {
  const unique = JSON.parse((await runCLI(["docs", "search", "render-hosts", "--json"], {})).stdout) as {
    status: string;
    result: { topics: Array<{ topic: string }> };
    next: { command: string };
  };
  assert.equal(unique.status, "matched");
  assert.deepEqual(unique.result.topics.map((topic) => topic.topic), ["render-hosts"]);
  assert.equal(unique.next.command, "itpay docs show render-hosts --json");

  const multiple = JSON.parse((await runCLI(["docs", "search", "checkout", "--json"], {})).stdout) as {
    status: string;
    result: { topics: unknown[] };
    next: null;
  };
  assert.equal(multiple.status, "matched");
  assert.ok(multiple.result.topics.length > 1);
  assert.equal(multiple.next, null);

  const empty = JSON.parse((await runCLI(["docs", "search", "no-such-doc-term", "--json"], {})).stdout) as {
    status: string;
    result: { topics: unknown[] };
    next: { command: string };
  };
  assert.equal(empty.status, "no_match");
  assert.deepEqual(empty.result.topics, []);
  assert.equal(empty.next.command, "itpay docs list --json");
});

test("docs reports a damaged packaged document without exposing its path", async () => {
  const docsDir = mkdtempSync(join(tmpdir(), "itpay-docs-invalid-"));
  writeFileSync(join(docsDir, "broken.json"), "{not-json", "utf8");
  await assert.rejects(
    runCLI(["docs", "list", "--json"], { ITPAY_CLI_DOCS_DIR: docsDir }),
    (error: unknown) => {
      const failure = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
        error: { code: string; message: string };
        recovery: Array<{ command: string }>;
      };
      assert.equal(failure.error.code, "docs_unavailable");
      assert.doesNotMatch(failure.error.message, new RegExp(docsDir));
      assert.equal(failure.recovery[0]?.command, "npm install -g @itpay/cli@2.0.11");
      return true;
    },
  );
});

test("checkout reads canonical presentation with display_token", async () => {
  const before = mock.requests.length;
  await runCheckoutPresentation(backend, {
    checkoutID: "chk_demo",
    displayToken: "cdt_demo",
    output: silent,
    baseURL: mock.url,
  });
  const req = mock.requests.find((item) => item.path === "/v1/checkouts/chk_demo/presentation?display_token=cdt_demo")!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/checkouts/chk_demo/presentation?display_token=cdt_demo");
  assert.equal(mock.requests.slice(before).some((item) => item.path === "/v1/checkouts/chk_demo/qr.png?display_token=cdt_demo"), false);
});

test("checkout pending JSON returns one compact human handoff", async () => {
  const output: string[] = [];
  await runCheckoutPresentation(backend, {
    checkoutID: "chk_pending",
    displayToken: "cdt_pending",
    host: "codex",
    output: (text) => output.push(text),
    baseURL: mock.url,
    jsonOutput: true,
  });
  const parsed = JSON.parse(output.join(""));
  assert.equal(parsed.status, "human_checkout_required");
  assert.deepEqual(parsed.result, { checkout_id: "chk_pending", payment: "pending", amount: "1.00 CNY" });
  assert.deepEqual(Object.keys(parsed.handoff), ["url", "qr_local_path", "markdown"]);
  assert.match(parsed.handoff.markdown, /itpay checkout --id chk_pending --token cdt_pending --json/);
  assert.match(parsed.instruction, /停止等待/);
  assert.match(parsed.instruction, /不要创建新 Checkout、Payment Intent 或 Execution/);
  assert.match(parsed.next.command, /checkout --id chk_pending --token cdt_pending --json$/);
  assert.equal("agent_guidance" in parsed, false);
  assert.equal("brand_qr_mirrors" in parsed, false);
});

test("workbuddy checkout JSON returns only the HTTPS QR handoff and exact tool instruction", async () => {
  const before = mock.requests.length;
  const result = await runCLI([
    "--agent-type", "workbuddy", "checkout",
    "--id", "chk_pending", "--token", "cdt_pending", "--json",
  ], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: mkdtempSync(join(tmpdir(), "itpay-workbuddy-checkout-")),
  });
  const envelope = JSON.parse(result.stdout) as {
    status: string;
    result: Record<string, unknown>;
    handoff: Record<string, string>;
    instruction: string;
    next: { command: string };
    recovery: unknown[];
  };
  assert.equal(result.stderr, "");
  assert.equal(envelope.status, "human_checkout_required");
  assert.deepEqual(Object.keys(envelope.handoff).sort(), ["qr_image_url", "url"]);
  assert.match(envelope.handoff.qr_image_url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1\/checkouts\/chk_pending\/qr\.png\?display_token=cdt_pending$/);
  assert.match(envelope.instruction, /present_files\(\{ files: \["<完整 qr_image_url>"\] \}\)/);
  assert.match(envelope.instruction, /如果 present_files 失败，只发送 handoff\.url/);
  assert.match(envelope.instruction, /不要调用 pay/);
  assert.equal(envelope.next.command, "itpay --agent-type workbuddy checkout --id chk_pending --token cdt_pending --json");
  assert.deepEqual(envelope.recovery, []);
  assert.equal(mock.requests.slice(before).some((request) => request.path.includes("/qr.png?display_token=")), false);
});

test("explicit terminal Host overrides WorkBuddy presentation without changing Agent Type", async () => {
  const result = await runCLI([
    "--agent-type", "workbuddy", "checkout", "--host", "terminal",
    "--id", "chk_pending", "--token", "cdt_pending", "--json",
  ], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: mkdtempSync(join(tmpdir(), "itpay-workbuddy-terminal-")),
  });
  const envelope = JSON.parse(result.stdout) as {
    handoff: Record<string, string>;
    instruction: string;
    next: { command: string };
  };
  assert.deepEqual(Object.keys(envelope.handoff), ["url"]);
  assert.doesNotMatch(envelope.instruction, /present_files/);
  assert.equal(envelope.next.command, "itpay --agent-type workbuddy checkout --id chk_pending --token cdt_pending --json");
});

test("checkout completed never prepares or recommends another payment handoff", async () => {
  const output: string[] = [];
  const before = mock.requests.length;
  await runCheckoutPresentation(backend, {
    checkoutID: "chk_completed",
    displayToken: "cdt_completed",
    host: "codex",
    output: (text) => output.push(text),
    baseURL: mock.url,
    jsonOutput: true,
  });
  const parsed = JSON.parse(output.join(""));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.result.payment, "verified");
  assert.equal(parsed.result.service_execution_id, "se_completed");
  assert.equal(parsed.next.command, "itpay services next se_completed --json");
  assert.equal("handoff" in parsed, false);
  assert.equal(mock.requests.slice(before).some((request) => request.path.includes("/qr.png")), false);
});

test("checkout command accepts the documented JSON form", async () => {
  const result = await runCLI([
    "--agent-type", "codex-desktop", "checkout",
    "--id", "chk_completed", "--token", "cdt_completed", "--json",
  ], { ITPAY_BACKEND_URL: mock.url });
  assert.equal(JSON.parse(result.stdout).status, "completed");
  assert.equal(result.stderr, "");
});

test("main buy persists checkout recovery state and consumes local cart", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-buy-"));
  const sessionPath = join(home, "cart.json");
  const before = mock.requests.length;
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
  assert.equal(saved.lastCartID, undefined);
  assert.match(saved.lastCheckoutID ?? "", /^chk_/);
  assert.equal(saved.lastDisplayToken, `cdt_${saved.lastCheckoutID}_secret`);
  assert.match(saved.lastCheckoutURL ?? "", /display_token=/);
  assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
  const checkoutRequest = mock.requests.slice(before).find((request) => request.method === "POST" && request.path === "/v1/checkouts");
  assert.equal(checkoutRequest?.headers["idempotency-key"], "cli_command_key");
});

test("buy reuses the canonical cart and idempotency key after a lost checkout response", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "item_retry",
    catalogVariantID: "v_retry",
    offerID: "o_retry",
    quantity: 1,
    output: silent,
  });
  const interruptedBackend = new BackendClient(new HttpClient({ baseURL: mock.url }));
  const createCheckout = interruptedBackend.createCheckout.bind(interruptedBackend);
  let loseResponse = true;
  interruptedBackend.createCheckout = async (input, idempotencyKey) => {
    const checkout = await createCheckout(input, idempotencyKey);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("simulated response loss");
    }
    return checkout;
  };
  const retryConfig: CLIConfig = { ...config, idempotencyKey: "checkout_retry_key", ideImageAttach: false };

  await assert.rejects(
    runBuy(interruptedBackend, retryConfig, { cartSession: session, host: "terminal", jsonOutput: true, output: silent }),
    /simulated response loss/,
  );
  const rememberedCartID = session.lastCartID;
  assert.match(rememberedCartID ?? "", /^cart_/);

  await runBuy(interruptedBackend, retryConfig, { cartSession: session, host: "terminal", jsonOutput: true, output: silent });
  const checkoutRequests = mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/checkouts");
  assert.equal(checkoutRequests.length, 2);
  assert.deepEqual(checkoutRequests.map((request) => request.body?.cart_id), [rememberedCartID, rememberedCartID]);
  assert.deepEqual(checkoutRequests.map((request) => request.headers["idempotency-key"]), ["checkout_retry_key", "checkout_retry_key"]);
  assert.equal(session.lastCartID, undefined);
  assert.match(session.lastCheckoutID ?? "", /^chk_/);
});

test("buy derives the handoff Host from every supported Agent Type", async () => {
  const expectedHosts: Record<string, string> = {
    "codex-desktop": "codex",
    "codex-cli": "terminal",
    "claude-code-desktop": "claude-code",
    "claude-code-cli": "terminal",
    workbuddy: "plain-chat",
  };
  for (const [agentType, expectedHost] of Object.entries(expectedHosts)) {
    const before = mock.requests.length;
    const result = await runCLI([
      "--agent-type", agentType, "buy", "--item", "item_1", "--variant", "v_1", "--offer", "o_1", "--json",
    ], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: mkdtempSync(join(tmpdir(), `itpay-buy-host-${agentType}-`)),
    });
    const envelope = JSON.parse(result.stdout) as {
      status: string;
      handoff: { url: string; qr_local_path?: string; qr_image_url?: string; markdown?: string };
      instruction: string;
    };
    assert.equal(envelope.status, "human_checkout_required");
    assert.match(envelope.handoff.url, /display_token=/);
    const desktop = expectedHost === "codex" || expectedHost === "claude-code";
    const expectedHandoffKeys = desktop
      ? ["markdown", "qr_local_path", "url"]
      : expectedHost === "plain-chat"
        ? ["qr_image_url", "url"]
        : ["url"];
    assert.deepEqual(Object.keys(envelope.handoff).sort(), expectedHandoffKeys);
    assert.equal(Boolean(envelope.handoff.markdown), desktop);
    assert.equal(Boolean(envelope.handoff.qr_image_url), expectedHost === "plain-chat");
    assert.equal(mock.requests.slice(before).some((request) => request.path.includes("/qr.png?display_token=")), desktop);
    if (agentType === "workbuddy") {
      assert.match(envelope.instruction, /present_files\(\{ files: \["<完整 qr_image_url>"\] \}\)/);
      assert.match(envelope.instruction, /然后停止等待/);
      assert.match(envelope.instruction, /不要检查本地文件/);
    } else {
      assert.doesNotMatch(envelope.instruction, /present_files/);
    }
    if (desktop) {
      assert.match(envelope.handoff.markdown ?? "", new RegExp(`itpay --agent-type ${agentType} checkout --id`));
    }
    const cartRequest = mock.requests.slice(before).find((request) => request.method === "POST" && request.path === "/v1/carts");
    assert.equal((cartRequest?.body as { client_context?: { host?: string } })?.client_context?.host, expectedHost);
  }
});

test("buy rejects invalid source, contact and numeric parameters before mutation", async () => {
  const cases: Array<{ args: string[]; code: string }> = [
    { args: ["--item", "item_1"], code: "buy_source_invalid" },
    { args: ["--cart", "cart_1", "--item", "item_1", "--variant", "v_1", "--offer", "o_1"], code: "buy_source_invalid" },
    { args: ["--item", "item_1", "--variant", "v_1", "--offer", "o_1", "--quantity", "1x"], code: "buy_parameter_invalid" },
    { args: ["--item", "item_1", "--variant", "v_1", "--offer", "o_1", "--require-contact", "fax"], code: "contact_field_invalid" },
    { args: ["--item", "item_1", "--variant", "v_1", "--offer", "o_1", "--require-contact", "email"], code: "missing_contact" },
    { args: ["--item", "item_1", "--variant", "v_1", "--offer", "o_1", "--no-wait"], code: "buy_parameter_invalid" },
  ];
  for (const entry of cases) {
    const home = mkdtempSync(join(tmpdir(), "itpay-buy-invalid-"));
    const before = mock.requests.length;
    await assert.rejects(
      runCLI(["--agent-type", "codex-cli", "buy", ...entry.args, "--json"], { ITPAY_BACKEND_URL: mock.url, HOME: home }),
      (error: unknown) => {
        const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
        assert.equal(envelope.error.code, entry.code);
        return true;
      },
    );
    assert.equal(mock.requests.length, before);
    assert.equal(CartSession.loadFromFile(join(home, ".itpay-v3", "cart.json"), "CNY").show().items.length, 0);
  }
});

test("main checkout without args uses saved checkout id and display token", async () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "itpay-cli-checkout-")), "cart.json");
  const session = new CartSession("CNY");
  session.rememberCheckout({
    checkoutID: "chk_saved",
    displayToken: "cdt_saved",
    checkoutURL: "https://sandbox.itpay.ai/checkout/chk_saved?display_token=cdt_saved",
  });
  session.saveToFile(sessionPath);

  const before = mock.requests.length;
  await runCLI(["checkout"], {
    ITPAY_BACKEND_URL: mock.url,
    ITPAY_CART_SESSION_PATH: sessionPath,
    ITPAY_IDE_IMAGE_ATTACH: "0",
  });

  const req = mock.requests.find((item) => item.path === "/v1/checkouts/chk_saved/presentation?display_token=cdt_saved")!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/checkouts/chk_saved/presentation?display_token=cdt_saved");
  assert.doesNotMatch(req.path, /undefined/);
  assert.equal(mock.requests.slice(before).some((item) => item.path === "/v1/checkouts/chk_saved/qr.png?display_token=cdt_saved"), false);
});

test("expired saved service checkout token returns an executable resume instruction", async () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "itpay-cli-expired-checkout-")), "cart.json");
  const session = new CartSession("CNY");
  session.rememberCheckout({
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
  ], env)).stdout) as { result: { checkout_id: string }; next: { command: string } };
  const resumed = JSON.parse((await runCLI([
    "services", "checkout", "se_instruction", "--resume", "--json",
  ], env)).stdout) as { result: { checkout_id: string }; next: { command: string } };
  assert.equal(resumed.result.checkout_id, created.result.checkout_id);
  assert.notEqual(resumed.next.command, created.next.command);
});

test("pay creates a checkout-bound payment intent", async () => {
  await runPay(backend, {
    checkoutID: "chk_pay", displayToken: "cdt_pay", method: "alipay", host: "terminal", refreshAction: true,
    jsonOutput: true, output: stdoutSink,
  });
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/checkouts/chk_pay/payment-intents");
  assert.equal((req.body as { payment_method_type: string }).payment_method_type, "alipay");
  assert.equal((req.body as { display_token: string }).display_token, "cdt_pay");
  assert.equal((req.body as { refresh_action: boolean }).refresh_action, true);
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string; result: { checkout_id: string; payment_intent_id: string }; handoff: Record<string, string>; next: { command: string };
  };
  assert.equal(envelope.status, "payment_action_ready");
  assert.equal(envelope.result.checkout_id, "chk_pay");
  assert.deepEqual(Object.keys(envelope.handoff).sort(), ["mobile_wallet_url", "qr_image_url"]);
  assert.equal(envelope.next.command, "itpay checkout --id chk_pay --token cdt_pay --json");
});

test("pay parser is strict, compact and Host-aware across every Agent Type", async () => {
  const instructions: string[] = [];
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const result = await runCLI([
      "--agent-type", agentType, "pay", "--checkout", `chk_${agentType}`, "--token", `cdt_${agentType}`, "--method", "alipay", "--json",
    ], { HOME: mkdtempSync(join(tmpdir(), `itpay-pay-${agentType}-`)), ITPAY_BACKEND_URL: mock.url });
    const envelope = JSON.parse(result.stdout) as {
      status: string; result: Record<string, unknown>; handoff: Record<string, string>; instruction: string; next: { command: string };
    };
    assert.equal(envelope.status, "payment_action_ready");
    assert.equal(Object.keys(envelope.result).length, 4);
    assert.deepEqual(Object.keys(envelope.handoff).sort(), ["mobile_wallet_url", "qr_image_url"]);
    assert.match(envelope.next.command, /checkout --id .* --token .* --json/);
    if (agentType === "workbuddy") {
      assert.match(envelope.instruction, /present_files\(\{ files: \["<完整 qr_image_url>"\] \}\)/);
      assert.match(envelope.instruction, /金额 1\.00 CNY/);
      assert.match(envelope.instruction, /停止等待/);
    } else {
      assert.doesNotMatch(envelope.instruction, /present_files/);
    }
    instructions.push(envelope.instruction);
  }
  assert.equal(new Set(instructions).size, 3);

  const before = mock.requests.length;
  await assert.rejects(
    runCLI(["--agent-type", "codex-cli", "pay", "--checkout", "chk_invalid", "--token", "cdt_invalid", "--method", "cash", "--json"], {
      HOME: mkdtempSync(join(tmpdir(), "itpay-pay-invalid-")), ITPAY_BACKEND_URL: mock.url,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "payment_method_invalid");
      return true;
    },
  );
  assert.equal(mock.requests.length, before);
});

test("pay recovers only the display token saved for the same checkout", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-pay-token-"));
  const session = new CartSession("CNY");
  session.rememberCheckout({ checkoutID: "chk_saved_pay", displayToken: "cdt_saved_pay", checkoutURL: "https://example.test/checkout/chk_saved_pay" });
  session.saveToFile(join(home, ".itpay-v3", "cart.json"));

  const recovered = await runCLI(["--agent-type", "codex-cli", "pay", "--checkout", "chk_saved_pay", "--method", "alipay", "--json"], {
    HOME: home, ITPAY_BACKEND_URL: mock.url,
  });
  assert.match(JSON.parse(recovered.stdout).next.command, /--token cdt_saved_pay --json$/);

  const before = mock.requests.length;
  await assert.rejects(
    runCLI(["--agent-type", "codex-cli", "pay", "--checkout", "chk_other", "--method", "alipay", "--json"], {
      HOME: home, ITPAY_BACKEND_URL: mock.url,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "checkout_token_required");
      return true;
    },
  );
  assert.equal(mock.requests.length, before);
});

test("pay never returns a payment handoff for verified or refunded intents", async () => {
  for (const [checkoutID, wantStatus] of [["chk_pay_verified", "payment_verified"], ["chk_pay_refunded", "payment_unavailable"]]) {
    const output: string[] = [];
    await runPay(backend, {
      checkoutID: checkoutID!, displayToken: "cdt_terminal", method: "alipay", host: "terminal", jsonOutput: true,
      output: (line) => output.push(line),
    });
    const envelope = JSON.parse(output.join("")) as { status: string; handoff?: unknown; next: { command: string } };
    assert.equal(envelope.status, wantStatus);
    assert.equal(envelope.handoff, undefined);
    assert.match(envelope.next.command, /checkout --id .* --token cdt_terminal --json/);
  }
});

test("services checkout JSON returns ItPay checkout handoff, not provider QR", async () => {
  const stdoutCaptureJSON: string[] = [];
  const before = mock.requests.length;
  await runServicesCheckout(backend, config, "se_demo", "precise_report", {
    email: "buyer@example.com",
    host: "plain-chat",
    agentType: "workbuddy",
    jsonOutput: true,
    output: (line) => stdoutCaptureJSON.push(line),
  });
  const json = JSON.parse(stdoutCaptureJSON.join("")) as {
    status: string;
    result: { checkout_id: string; capability_id: string; locked_input: Record<string, unknown>; amount: string };
    handoff: { url: string; qr_local_path?: string; qr_image_url?: string; markdown?: string };
    instruction: string;
    next: { command: string };
    recovery: unknown[];
  };
  assert.equal(json.status, "human_checkout_required");
  assert.match(json.handoff.url, /^https:\/\/sandbox\.itpay\.ai\/checkout\/chk_/);
  assert.match(json.handoff.url, /display_token=/);
  assert.match(json.handoff.qr_image_url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1\/checkouts\/chk_\d+\/qr\.png\?display_token=/);
  assert.deepEqual(Object.keys(json.handoff).sort(), ["qr_image_url", "url"]);
  assert.equal(json.result.capability_id, "precise_report");
  assert.deepEqual(json.result.locked_input, {});
  assert.equal(json.result.amount, "0.50 CNY");
  assert.match(json.instruction, /present_files\(\{ files: \["<完整 qr_image_url>"\] \}\)/);
  assert.match(json.instruction, /然后停止等待/);
  assert.match(json.instruction, /不要检查本地文件/);
  assert.match(json.instruction, /不要调用 pay/);
  assert.match(json.next.command, /itpay checkout --id .* --json$/);
  assert.deepEqual(json.recovery, []);
  assert.equal("service_quote_lock_id" in json, false);
  assert.equal("display_token" in json, false);
  assert.equal("agent_guidance" in json, false);
  assert.equal("agent_action" in json, false);
  assert.equal("brand_qr_mirrors" in json, false);
  assert.ok(!JSON.stringify(json).includes("qr.alipay.com"));
  assert.equal(mock.requests.slice(before).some((req) => req.path.includes("/qr.png?display_token=")), false);
  assert.equal(JSON.stringify(json).includes("agent_access_token"), false);

  const displayToken = json.next.command.match(/--token ([^ ]+)/)?.[1];
  assert.ok(displayToken);
  const presentationOutput: string[] = [];
  await runCheckoutPresentation(backend, {
    checkoutID: json.result.checkout_id,
    displayToken,
    jsonOutput: true,
    output: (line) => presentationOutput.push(line),
    baseURL: mock.url,
  });
  const presentation = JSON.parse(presentationOutput.join("")) as {
    result: { amount: string };
  };
  assert.equal(presentation.result.amount, "0.50 CNY");
});

test("services checkout resume reissues the same checkout and persists before output", async () => {
  const firstOutput: string[] = [];
  await runServicesCheckout(backend, config, "se_resume", "precise_report", {
    email: "buyer@example.com",
    host: "codex",
    jsonOutput: true,
    output: (line) => firstOutput.push(line),
  });
  const first = JSON.parse(firstOutput.join("")) as { result: { checkout_id: string }; next: { command: string } };

  let persisted = false;
  const resumedOutput: string[] = [];
  await runServicesCheckout(backend, config, "se_resume", undefined, {
    resume: true,
    host: "codex",
    jsonOutput: true,
    persistHandoff: (handoff) => {
      persisted = handoff.checkoutID === first.result.checkout_id && !first.next.command.includes(handoff.displayToken);
    },
    output: (line) => {
      assert.equal(persisted, true, "handoff must be persisted before CLI output");
      resumedOutput.push(line);
    },
  });
  const resumed = JSON.parse(resumedOutput.join("")) as { result: { checkout_id: string }; next: { command: string } };
  assert.equal(resumed.result.checkout_id, first.result.checkout_id);
  assert.notEqual(resumed.next.command, first.next.command);
  const requests = mock.requests.filter((request) => request.path === "/v1/service-executions/se_resume/checkout");
  assert.equal(requests.length, 2);
  assert.equal((requests[1]?.body as { resume?: boolean }).resume, true);
  assert.equal((requests[1]?.body as { delivery_contact?: unknown }).delivery_contact, undefined);
});

test("services read-result relies on device authority instead of a checkout token", async () => {
  await runServicesReadResult(backend, "se_granted", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { service_execution_id: string; grant_expires_at: string; granted_fields: string[]; payload: Record<string, unknown> };
  };
  assert.equal(envelope.status, "granted_result_ready");
  assert.equal(envelope.result.service_execution_id, "se_granted");
  assert.equal(envelope.result.grant_expires_at, "2026-07-13T12:15:00Z");
  assert.deepEqual(envelope.result.granted_fields, ["summary"]);
  assert.deepEqual(envelope.result.payload, { summary: "granted" });
  const req = mock.requests.at(-1)!;
  assert.equal(req.path, "/v1/service-executions/se_granted/granted-result");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.path.includes("agent_device_id"), false);
});

test("services next and read-result commands accept the documented JSON form", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-delivery-"));
  const env = { ITPAY_BACKEND_URL: mock.url, HOME: home };
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const nextResult = await runCLI([
      "--agent-type", agentType, "services", "next", "se_granted", "--json",
    ], env);
    assert.equal(JSON.parse(nextResult.stdout).status, "grant_active");
    assert.equal(nextResult.stderr, "");

    const readResult = await runCLI([
      "--agent-type", agentType, "services", "read-result", "se_granted", "--json",
    ], env);
    const envelope = JSON.parse(readResult.stdout) as { status: string; result: { payload: Record<string, unknown> } };
    assert.equal(envelope.status, "granted_result_ready");
    assert.deepEqual(envelope.result.payload, { summary: "granted" });
    assert.equal(readResult.stderr, "");
  }
});

test("services read-result returns structured user-action recovery when access is denied", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-delivery-denied-"));
  for (const serviceExecutionID of ["se_vault_none", "se_vault_denied"]) {
    await assert.rejects(
      execFileAsync(TSX_BIN, [
        CLI_ENTRY, "--agent-type", "codex-cli", "services", "read-result", serviceExecutionID, "--json",
      ], {
        cwd: CLI_ROOT,
        env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: home },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr ?? "");
        const envelope = JSON.parse(stderr) as {
          status: string;
          error: { code: string };
          instruction: string;
          recovery: Array<{ command: string }>;
        };
        assert.equal(envelope.status, "error");
        assert.equal(envelope.error.code, "agent_access_denied");
        assert.match(envelope.instruction, /用户.*授权/);
        assert.equal(envelope.recovery[0]?.command, `itpay --agent-type codex-cli services next ${serviceExecutionID} --json`);
        return true;
      },
    );
  }
});

test("services action rejects unsupported statuses before HTTP", async () => {
  await assert.rejects(
    runServicesAction(backend, "se_bad_status", "select_candidate", {}, {
      status: "completed",
      output: silent,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommandContractError);
      assert.equal(error.code, "service_action_invalid");
      assert.match(error.message, /invalid --status "completed"/);
      return true;
    },
  );
  assert.equal(mock.requests.some((req) => req.path.includes("/v1/service-executions/se_bad_status/actions")), false);
});

test("services action resolves a human-selected candidate rank from the execution", async () => {
  await runServicesInvoke(backend, config, "se_select_by_rank", "fuzzy_disambiguation", { keyword: "小米" }, { output: silent });
  await runServicesAction(backend, "se_select_by_rank", "select_candidate", {}, {
    actorType: "human",
    status: "approved",
    candidateRank: 1,
    jsonOutput: true,
    output: stdoutSink,
  });
  const requests = mock.requests.filter((request) => request.path.includes("/v1/service-executions/se_select_by_rank"));
	assert.equal(requests.at(-3)?.method, "GET");
	assert.equal(requests.at(-2)?.method, "POST");
	assert.equal(requests.at(-1)?.method, "GET");
	assert.deepEqual(requests.at(-2)?.body, {
    action_type: "select_candidate",
    actor_type: "human",
    status: "approved",
    result_item_id: "scri_1",
    input_snapshot: {},
  });
  assert.deepEqual(JSON.parse(stdoutCapture.join("")), {
		status: "candidate_selected",
		result: {
			service_execution_id: "se_select_by_rank",
			candidate: {
				rank: 1,
				title: "小米汽车科技有限公司",
			},
			checkout: {
				capability_id: "precise_report",
				price: { amount_minor: 50, currency: "CNY" },
				delivery_email_required: true,
			},
		},
		instruction: "已选择 小米汽车科技有限公司。候选已绑定到当前 Execution，但尚未购买后续服务。现在只向用户说明：继续购买后续服务需要支付 0.50 CNY，并提供用于发送交付认领链接的邮箱；请确认是否购买并提供邮箱。然后停止。用户明确同意并提供真实邮箱前，不要执行 next.command，不要创建新 Execution 或 Checkout。",
		next: {
			command: "itpay services checkout se_select_by_rank --capability precise_report --email <email> --json",
			reason: "仅在用户明确同意支付 0.50 CNY 并提供真实邮箱后执行；否则停止",
		},
		recovery: [{
			command: "itpay services next se_select_by_rank --json",
			reason: "重新读取服务端允许的动作",
		}],
  });
});

test("services action command accepts the documented --json form", async () => {
  await runServicesInvoke(
    backend,
    config,
    "se_action_cli",
    "fuzzy_disambiguation",
    { keyword: "小米" },
    { output: silent },
  );
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-service-action-"));
  const result = await runCLI([
    "--agent-type", "codex-cli", "services", "action", "se_action_cli",
    "--action", "select_candidate", "--actor-type", "human", "--status", "approved",
    "--candidate", "1", "--json",
  ], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: home,
  });
	assert.equal(JSON.parse(result.stdout).status, "candidate_selected");
  assert.equal(result.stderr, "");
});

test("catalog list supports JSON output", async () => {
  const output: string[] = [];
  await runCatalogList(backend, { jsonOutput: true, output: (line) => output.push(line) });
  const parsed = JSON.parse(output.join("")) as {
    status: string;
    result: { services: Array<{ service_id: string; discovery?: { free_quota?: number } }> };
    next: { command: string };
  };
  assert.equal(parsed.status, "listed");
  assert.equal(parsed.result.services[0]?.service_id, "svc_qizhidao_company_lookup");
  assert.equal(parsed.result.services[0]?.discovery?.free_quota, 3);
  assert.equal(parsed.next.command, "itpay services start svc_qizhidao_company_lookup --json");
  assert.equal("manifest" in parsed, false);
});

test("catalog text explains auxiliary discovery before the primary service", async () => {
  const output: string[] = [];
  await runCatalogList(backend, { output: (line) => output.push(line) });
  const text = output.join("");
  assert.match(text, /discovery: Confirm company identity; free_quota: 3; paid_price: ¥0\.10/);
  assert.match(text, /primary_offer: Precise company report; price: ¥0\.50/);
  assert.doesNotMatch(text, /catalog_variant_id|snapshot_id|provider:/);
  assert.match(text, /instruction: 向用户解释主服务、辅助步骤和价格/);
});

test("catalog empty response does not invent a service id", async () => {
  const output: string[] = [];
  const emptyBackend = {
    getCatalogManifest: async () => ({
      version: "cat_empty",
      status: "published",
      item_count: 0,
      manifest: { items: [] },
    }),
  } as unknown as BackendClient;
  await runCatalogList(emptyBackend, { jsonOutput: true, output: (line) => output.push(line) });
  const parsed = JSON.parse(output.join(""));
  assert.equal(parsed.status, "catalog_empty");
  assert.deepEqual(parsed.result.services, []);
  assert.equal(parsed.next.command, "itpay catalog list --json");
  assert.match(parsed.instruction, /不要猜测 service_id/);
});

test("services start returns only the documented capability entrypoint", async () => {
  const output: string[] = [];
  await runServicesStart(backend, "svc_qizhidao_company_lookup", {
    host: "terminal",
    jsonOutput: true,
    output: (line) => output.push(line),
  });
  const parsed = JSON.parse(output.join(""));
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.result.service_id, "svc_qizhidao_company_lookup");
  assert.equal(parsed.result.capability.capability_id, "fuzzy_disambiguation");
  assert.deepEqual(parsed.result.capability.required_input, ["keyword"]);
  assert.match(parsed.next.command, /--input keyword=<value> --json$/);
  assert.equal("execution" in parsed, false);
  assert.equal("capabilities" in parsed, false);
  assert.equal("agent_guidance" in parsed, false);
  const request = [...mock.requests].reverse().find((item) => item.method === "POST" && item.path === "/v1/service-executions");
  assert.equal("buyer_id" in (request?.body ?? {}), false);
  assert.equal("agent_device_id" in (request?.body ?? {}), false);
  assert.equal("agent_device_id" in ((request?.body?.client_context as Record<string, unknown> | undefined) ?? {}), false);
});

test("services start command accepts --json after the subcommand", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-service-start-"));
  const result = await runCLI([
    "--agent-type", "codex-cli", "services", "start", "svc_qizhidao_company_lookup", "--json",
  ], {
    ITPAY_BACKEND_URL: mock.url,
    HOME: home,
  });
  assert.equal(JSON.parse(result.stdout).status, "ready");
  assert.equal(result.stderr, "");
});

test("services checkout renders the branded checkout QR by default", async () => {
  await runServicesCheckout(backend, config, "se_render", "precise_report", {
    email: "buyer@example.com",
    host: "codex",
    output: stdoutSink,
  });
  const text = stdoutCapture.join("");
  assert.match(text, /^human_checkout_required/m);
  assert.match(text, /handoff\.markdown:/);
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
	await runServicesCheckout(backend, config, "se_paid_fuzzy", "fuzzy_disambiguation_paid", {
		lockedInput: { keyword: "京东" },
		output: silent,
	});
	const request = [...mock.requests].reverse().find((request) =>
		request.method === "POST" && request.path === "/v1/service-executions/se_paid_fuzzy/checkout",
	);
	assert.deepEqual(request?.body?.locked_input, { keyword: "京东" });
});

test("services checkout rejects missing required input before creating checkout resources", async () => {
  const before = mock.requests.length;
  await assert.rejects(
    runServicesCheckout(backend, config, "se_missing_paid_input", "fuzzy_disambiguation_paid", { output: silent }),
    (error: unknown) => {
      assert.ok(error instanceof CommandContractError);
      assert.equal(error.code, "capability_input_invalid");
      assert.match(error.recovery[0]?.command ?? "", /--input keyword=<value>/);
      return true;
    },
  );
  const requests = mock.requests.slice(before);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
});

test("order reads one canonical order by id", async () => {
  await runOrder(backend, "ord_delivery", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { order_code: string; delivery_mode: string; access_locked: boolean; service_execution_id: string };
    next: { command: string };
  };
  assert.equal(envelope.status, "delivered");
  assert.equal(envelope.result.order_code, "IP-DELIVERY");
  assert.equal(envelope.result.delivery_mode, "vault_artifact");
  assert.equal(envelope.result.access_locked, false);
  assert.equal(envelope.result.service_execution_id, "se_granted");
  assert.equal(envelope.next.command, "itpay services next se_granted --json");
  assert.deepEqual(mock.requests.slice(-3).map((req) => req.path).sort(), [
    "/v1/orders/ord_delivery",
    "/v1/orders/ord_delivery/delivery-access",
    "/v1/orders/ord_delivery/refunds",
  ].sort());
});

test("order reports a refund access lock instead of delivery guidance", async () => {
  await runOrder(backend, "ord_locked", { jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    result: { access_locked: boolean; refund: { refund_request_id: string; status: string } };
    instruction: string;
    next: { command: string };
  };
  assert.equal(envelope.result.access_locked, true);
  assert.deepEqual(envelope.result.refund, { refund_request_id: "rr_locked", status: "accepted" });
  assert.match(envelope.instruction, /不要 reveal/);
  assert.equal(envelope.next.command, "itpay refund get rr_locked --json");
});

test("order keeps business output identical across all supported Agent Types", async () => {
  const outputs: string[] = [];
  for (const host of ["codex", "terminal", "claude-code", "terminal", "plain-chat"]) {
    const current: string[] = [];
    await runOrder(backend, "ord_agent_visible", { host, jsonOutput: true, output: (line) => current.push(line) });
    outputs.push(current.join(""));
  }
  assert.equal(new Set(outputs).size, 1);
  const envelope = JSON.parse(outputs[0]!) as { result: { delivery_mode: string }; next: { command: string } };
  assert.equal(envelope.result.delivery_mode, "agent_visible_result");
  assert.equal(envelope.next.command, "itpay services next se_agent_visible --json");
});

test("order command accepts JSON and returns structured opaque not-found recovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "itpay-cli-order-"));
  const result = await runCLI([
    "--agent-type", "codex-cli", "order", "ord_delivery", "--json",
  ], { ITPAY_BACKEND_URL: mock.url, HOME: home });
  assert.equal(JSON.parse(result.stdout).status, "delivered");
  assert.equal(result.stderr, "");

  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "order", "ord_missing", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: home },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
        status: string; error: { code: string }; recovery: Array<{ command: string }>;
      };
      assert.equal(envelope.status, "error");
      assert.equal(envelope.error.code, "not_found");
      assert.equal(envelope.recovery[0]?.command, "itpay --agent-type codex-cli services list --json");
      return true;
    },
  );
});

test("orders requires an account-scoped bearer", async () => {
  const configWithoutBearer = { ...config };
  delete configWithoutBearer.bearerToken;
  await assert.rejects(
    runListOrders(backend, configWithoutBearer, { limit: 10, output: silent }),
    (error: unknown) => (error as { code?: string }).code === "session_required",
  );
});

test("orders lists account orders with a valid bearer", async () => {
  mock.setAccountOrders([{
    order_id: "ord_latest",
    order_code: "IP-LATEST",
    checkout_id: "chk_latest",
    status: "delivered",
    amount_minor: 50,
    currency: "CNY",
    created_at: "2026-07-13T12:00:00Z",
    items: [{ title: "Must not leak", input: { secret: true } }],
    delivery_artifacts: [{ vault_artifact_id: "vault_must_not_leak" }],
  }]);
  await runListOrders(backend, { ...config, bearerToken: "account_token" }, {
    limit: 5,
    jsonOutput: true,
    output: stdoutSink,
  });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { orders: Array<Record<string, unknown>> };
    next: { command: string };
  };
  assert.equal(envelope.status, "listed");
  assert.deepEqual(envelope.result.orders, [{
    order_id: "ord_latest",
    order_code: "IP-LATEST",
    status: "delivered",
    amount: "0.50 CNY",
    created_at: "2026-07-13T12:00:00Z",
  }]);
  assert.equal(envelope.next.command, "itpay order ord_latest --json");
  assert.doesNotMatch(stdoutCapture.join(""), /Must not leak|vault_must_not_leak|chk_latest/);
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/v1/me/orders?limit=5");
  assert.equal(req.headers["authorization"], "Bearer account_token");
});

test("orders validates filters before issuing an HTTP request", async () => {
  const requestCount = mock.requests.length;
  await assert.rejects(
    runListOrders(backend, { ...config, bearerToken: "account_token" }, { limit: 0, output: silent }),
    (error: unknown) => (error as { code?: string }).code === "limit_invalid",
  );
  await assert.rejects(
    runListOrders(backend, { ...config, bearerToken: "account_token" }, { limit: 20, status: "typo", output: silent }),
    (error: unknown) => (error as { code?: string }).code === "order_status_invalid",
  );
  assert.equal(mock.requests.length, requestCount);
});

test("orders JSON contract is stable for every supported Agent Type", async () => {
  mock.setAccountOrders([{
    order_id: "ord_agent_types",
    order_code: "IP-TYPES",
    checkout_id: "chk_types",
    status: "paid",
    amount_minor: 10,
    currency: "CNY",
    created_at: "2026-07-13T13:00:00Z",
    items: [],
    delivery_artifacts: [],
  }]);
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const result = await runCLI(["--agent-type", agentType, "orders", "--limit", "1", "--json"], {
      ITPAY_BACKEND_URL: mock.url,
      ITPAY_BEARER_TOKEN: "account_token",
      HOME: mkdtempSync(join(tmpdir(), `itpay-orders-${agentType}-`)),
    });
    const envelope = JSON.parse(result.stdout) as { status: string; result: { orders: Array<{ order_id: string }> } };
    assert.equal(envelope.status, "listed");
    assert.equal(envelope.result.orders[0]?.order_id, "ord_agent_types");
    assert.equal(result.stderr, "");
  }
});

test("orders surfaces account_scope_required as HttpError", async () => {
  await assert.rejects(
    runListOrders(backend, { ...config, bearerToken: "order_token" }, { limit: 5, output: silent }),
    (error: unknown) => (error as { code?: string }).code === "account_scope_required",
  );
});

test("refund list returns a compact latest-first order view", async () => {
  await runListRefunds(backend, { orderID: "ord_locked", jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { order_id: string; refunds: Array<Record<string, unknown>> };
    next: { command: string };
  };
  assert.equal(envelope.status, "listed");
  assert.equal(envelope.result.order_id, "ord_locked");
  assert.deepEqual(envelope.result.refunds, [{
    refund_request_id: "rr_locked",
    status: "accepted",
    amount: "0.50 CNY",
    created_at: "2026-07-13T12:00:00Z",
  }]);
  assert.equal(envelope.next.command, "itpay refund get rr_locked --json");
  assert.doesNotMatch(stdoutCapture.join(""), /consumption_state|decision_mode|buyer_requested/);
});

test("refund list handles an empty order without inventing a refund", async () => {
  await runListRefunds(backend, { orderID: "ord_delivery", jsonOutput: true, output: stdoutSink });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { refunds: unknown[] };
    next: { command: string };
  };
  assert.equal(envelope.status, "empty");
  assert.deepEqual(envelope.result.refunds, []);
  assert.equal(envelope.next.command, "itpay refund create --order ord_delivery --json");
});

test("refund list parser accepts child options for every supported Agent Type", async () => {
  for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
    const result = await runCLI([
      "--agent-type", agentType, "refund", "list", "--order", "ord_locked", "--json",
    ], {
      ITPAY_BACKEND_URL: mock.url,
      HOME: mkdtempSync(join(tmpdir(), `itpay-refund-list-${agentType}-`)),
    });
    const envelope = JSON.parse(result.stdout) as { status: string; result: { refunds: Array<{ refund_request_id: string }> } };
    assert.equal(envelope.status, "listed");
    assert.equal(envelope.result.refunds[0]?.refund_request_id, "rr_locked");
    assert.equal(result.stderr, "");
  }
});

test("refund list rejects a missing order before HTTP", async () => {
  const requestCount = mock.requests.length;
  await assert.rejects(
    execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "refund", "list", "--json"], {
      cwd: CLI_ROOT,
      env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: mkdtempSync(join(tmpdir(), "itpay-refund-list-missing-")) },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as { error: { code: string } };
      assert.equal(envelope.error.code, "order_required");
      return true;
    },
  );
  assert.equal(mock.requests.length, requestCount);
});

test("refund issues a refund request with Idempotency-Key", async () => {
  await runRefund(backend, { ...config, bearerToken: "account_token" }, {
    orderID: "ord_42",
    reason: "buyer_requested",
    jsonOutput: true,
    output: stdoutSink,
  });
  const envelope = JSON.parse(stdoutCapture.join("")) as {
    status: string;
    result: { refund_status: string; decision_mode: string; access_locked: boolean; can_cancel: boolean };
    next: { command: string };
  };
  assert.equal(envelope.status, "requested");
  assert.equal(envelope.result.refund_status, "accepted");
  assert.equal(envelope.result.decision_mode, "automatic");
  assert.equal(envelope.result.access_locked, true);
  assert.equal(envelope.result.can_cancel, true);
  assert.match(envelope.next.command, /^itpay refund watch rr_/);
  const req = mock.requests.at(-1)!;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/v1/orders/ord_42/refunds");
  assert.equal(req.headers.authorization, "Bearer account_token");
  assert.equal(req.headers["idempotency-key"], "cli_smoke_key");
  assert.deepEqual(req.body, { reason: "buyer_requested" });
});

test("refund uses signed device authority without buyer bearer and supports recovery commands", async () => {
	const signedBackend = new BackendClient(new HttpClient({ baseURL: mock.url, requestAuthorizer: async () => ({ Authorization: "ItPayDevice device_session" }) }));
	const { bearerToken: _bearerToken, ...deviceConfig } = config;
	await runRefund(signedBackend, deviceConfig, { orderID: "ord_42", output: silent });
	assert.equal(mock.requests.at(-1)?.headers.authorization, "ItPayDevice device_session");
	await runGetRefund(signedBackend, "rr_1", { output: silent });
	assert.equal(mock.requests.at(-1)?.path, "/v1/refunds/rr_1");
	await runCancelRefund(signedBackend, "rr_1", undefined, { output: silent });
	assert.equal(mock.requests.at(-1)?.path, "/v1/refunds/rr_1/cancel");
});

test("refund create parses child options and signs with device authority", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-"));
	for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
		const result = await runCLI(["--agent-type", agentType, "refund", "create", "--order", "ord_42", "--reason", "buyer_requested", "--json"], {
			HOME: home,
			ITPAY_BACKEND_URL: mock.url,
			ITPAY_IDEMPOTENCY_KEY: `refund_command_key_${agentType}`,
		});
		assert.equal(JSON.parse(result.stdout).status, "requested");
		assert.equal(result.stderr, "");
	}
	const request = mock.requests.find((item) => item.path === "/v1/orders/ord_42/refunds");
	assert.match(request?.headers.authorization ?? "", /^ItPayDevice /);
});

test("refund create rejects a missing order before HTTP with structured recovery", async () => {
	const before = mock.requests.length;
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-missing-"));
	await assert.rejects(
		execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "refund", "create", "--json"], {
			cwd: CLI_ROOT,
			env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: home },
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		}),
		(error: unknown) => {
			const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
				status: string; error: { code: string }; instruction: string;
			};
			assert.equal(envelope.status, "error");
			assert.equal(envelope.error.code, "order_required");
			assert.match(envelope.instruction, /不要猜测/);
			return true;
		},
	);
	assert.equal(mock.requests.length, before);
});

test("refund get returns one compact authoritative snapshot for every Agent Type", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-get-"));
	for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
		const result = await runCLI(["--agent-type", agentType, "refund", "get", "rr_1", "--json"], {
			HOME: home,
			ITPAY_BACKEND_URL: mock.url,
		});
		const envelope = JSON.parse(result.stdout) as {
			status: string; result: { refund_status: string; access_locked: boolean }; next: { command: string };
		};
		assert.equal(envelope.status, "shown");
		assert.equal(envelope.result.refund_status, "accepted");
		assert.equal(envelope.result.access_locked, true);
		assert.equal(envelope.next.command, `itpay --agent-type ${agentType} refund watch rr_1 --json`);
		assert.equal(result.stderr, "");
	}
});

test("refund get keeps missing and foreign refund IDs opaque", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-get-missing-"));
	await assert.rejects(
		execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "refund", "get", "rr_missing", "--json"], {
			cwd: CLI_ROOT,
			env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: home },
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		}),
		(error: unknown) => {
			const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
				status: string; error: { code: string }; instruction: string;
			};
			assert.equal(envelope.status, "error");
			assert.equal(envelope.error.code, "not_found");
			assert.match(envelope.instruction, /不要探测/);
			return true;
		},
	);
});

test("refund get reports manual review from server truth", async () => {
	await runGetRefund(backend, "rr_manual", { jsonOutput: true, output: stdoutSink });
	const envelope = JSON.parse(stdoutCapture.join("")) as {
		result: { decision_mode: string; refund_status: string; consumption_state: string; access_locked: boolean };
		instruction: string;
	};
	assert.deepEqual(envelope.result, {
		refund_request_id: "rr_manual",
		order_id: "ord_42",
		decision_mode: "manual",
		refund_status: "policy_review_required",
		consumption_state: "consumed",
		access_locked: true,
		can_cancel: true,
	});
	assert.match(envelope.instruction, /人工审核/);
});

test("refund watch emits one terminal envelope for every Agent Type", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-watch-"));
	for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
		const result = await runCLI(["--agent-type", agentType, "refund", "watch", "rr_succeeded", "--json"], {
			HOME: home,
			ITPAY_BACKEND_URL: mock.url,
		});
		const envelope = JSON.parse(result.stdout) as {
			status: string; result: { refund_status: string; access_locked: boolean }; next: unknown;
		};
		assert.equal(envelope.status, "watch_complete");
		assert.equal(envelope.result.refund_status, "succeeded");
		assert.equal(envelope.result.access_locked, true);
		assert.equal(envelope.next, null);
		assert.equal(result.stderr, "");
	}
});

test("refund watch timeout is a resumable state, not a refund failure", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-watch-timeout-"));
	const result = await runCLI([
		"--agent-type", "codex-cli", "refund", "watch", "rr_pending", "--interval", "1", "--timeout", "0.01", "--json",
	], { HOME: home, ITPAY_BACKEND_URL: mock.url });
	const envelope = JSON.parse(result.stdout) as {
		status: string; result: { last_status: string }; instruction: string; next: { command: string };
	};
	assert.equal(envelope.status, "watch_timeout");
	assert.equal(envelope.result.last_status, "accepted");
	assert.match(envelope.instruction, /不要重复申请/);
	assert.equal(envelope.next.command, "itpay --agent-type codex-cli refund watch rr_pending --json");
	assert.equal(result.stderr, "");
});

test("refund watch validates polling parameters before HTTP", async () => {
	const before = mock.requests.length;
	await assert.rejects(
		runWatchRefund(backend, "rr_pending", { intervalSeconds: 0, timeoutSeconds: 1, jsonOutput: true, output: silent }),
		/--interval must be at least 1 second/,
	);
	assert.equal(mock.requests.length, before);
});

test("refund cancel releases the lock and requires a new delivery authorization", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-cancel-"));
	for (const agentType of ["codex-desktop", "codex-cli", "claude-code-desktop", "claude-code-cli", "workbuddy"]) {
		const result = await runCLI(["--agent-type", agentType, "refund", "cancel", "rr_active", "--reason", "buyer_cancelled", "--json"], {
			HOME: home,
			ITPAY_BACKEND_URL: mock.url,
		});
		const envelope = JSON.parse(result.stdout) as {
			status: string; result: { order_id: string; access_locked: boolean }; instruction: string; next: { command: string };
		};
		assert.equal(envelope.status, "cancelled");
		assert.equal(envelope.result.access_locked, false);
		assert.match(envelope.instruction, /新的授权/);
		assert.equal(envelope.next.command, `itpay --agent-type ${agentType} order ord_42 --json`);
		assert.equal(result.stderr, "");
	}
});

test("refund cancel keeps a too-late refund locked and returns state recovery", async () => {
	const home = mkdtempSync(join(tmpdir(), "itpay-cli-refund-cancel-late-"));
	await assert.rejects(
		execFileAsync(TSX_BIN, [CLI_ENTRY, "--agent-type", "codex-cli", "refund", "cancel", "rr_too_late", "--json"], {
			cwd: CLI_ROOT,
			env: { ...process.env, ITPAY_BACKEND_URL: mock.url, HOME: home },
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		}),
		(error: unknown) => {
			const envelope = JSON.parse(String((error as { stderr?: string }).stderr ?? "")) as {
				status: string; error: { code: string }; recovery: Array<{ command: string }>;
			};
			assert.equal(envelope.status, "error");
			assert.equal(envelope.error.code, "refund_cancellation_too_late");
			assert.equal(envelope.recovery[0]?.command, "itpay --agent-type codex-cli refund get rr_too_late --json");
			return true;
		},
	);
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

test("runBuy JSON output exposes only the current Host handoff", async () => {
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
    agentType: "workbuddy",
    jsonOutput: true,
    output: jsonSink,
  });
  const json = JSON.parse(stdoutCaptureJSON.join("")) as {
    status: string;
    result: { checkout_id: string; payment: string; amount: string; item_count: number };
    handoff: { url: string; qr_local_path?: string; qr_image_url?: string };
    next: { command: string };
  };
  assert.equal(json.status, "human_checkout_required");
  assert.deepEqual(json.result, { checkout_id: json.result.checkout_id, payment: "pending", amount: "1.00 CNY", item_count: 1 });
  assert.match(json.handoff.url, /display_token=/);
  assert.deepEqual(Object.keys(json.handoff).sort(), ["qr_image_url", "url"]);
  assert.match(json.handoff.qr_image_url ?? "", /\/qr\.png\?display_token=/);
  assert.match(json.next.command, /checkout --id .* --token .* --json/);
  assert.equal("brand_qr_mirrors" in json, false);
  assert.equal("brand_qr_data_url" in json, false);
  assert.equal("agent_action" in json, false);
});

test("buy routes service-backed carts to Service Execution before checkout", async () => {
  const session = new CartSession("CNY");
  runCartAdd(session, {
    catalogItemID: "cat_service",
    catalogVariantID: "var_service",
    offerID: "offer_service",
    quantity: 1,
    output: silent,
  });
  await assert.rejects(
    runBuy(backend, config, { cartSession: session, host: "codex", jsonOutput: true, output: silent }),
    (error: unknown) => {
      assert.ok(error instanceof CommandContractError);
		assert.equal(error.code, "service_quote_required");
      assert.equal(error.recovery[0]?.command, "itpay services next se_mock_1 --json");
      return true;
    },
  );
  assert.equal(mock.requests.some((request) => request.path === "/v1/checkouts"), false);
  assert.equal(session.lastServiceExecutionID, "se_mock_1");
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
