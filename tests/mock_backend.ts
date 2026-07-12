// Minimal V3 mock backend used by the CLI smoke test. It implements just
// enough of the V3 surface to exercise the CLI command flow end to end:
//   readyz, carts, checkouts, payment-intents, orders, me/orders, refunds
//
// The mock records every request so tests can assert headers (Bearer,
// Idempotency-Key) and body shapes. DTOs intentionally mirror the Go
// presenters in services/backend/internal/presenter/*.go.

import http from "node:http";
import { AddressInfo } from "node:net";

// Minimal 16x16 brand PNG. Smaller than the real V3 asset but enough
// for the IDE image viewer smoke tests to assert downloaded bytes.
const BRAND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAm0lEQVR4nGP8//8/" +
  "AymAkZGRgYGBubm5kZGRsbGxiYmJqampmZmZkZGRsbGxiYmJqampmZmZkZGRsbGx" +
  "iYmJqampmZmZkZGRsbGxiYmJqampmZmZkZGRsbGxiYmJqampmZmZkZGRsbGxiYmJ" +
  "qampmZmZkZGRsbGxiYmJqampmZmZUQAHMf+gAMT///////8/AAAA//8DAIAF/wD//" +
  "//////////////////////////////////////////////////////////////////8A" +
  "AAAASUVORK5CYII=";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface MockBackendHandle {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startMockBackend(): Promise<MockBackendHandle> {
  const requests: RecordedRequest[] = [];

  // Mutable state simulating a tiny slice of the V3 backend.
  let cartCounter = 1;
  let checkoutCounter = 1;
  let paymentIntentCounter = 1;
  let orderCounter = 1;
  let refundCounter = 1;
  let pendingAgentType = "codex-cli";
  let serviceHandoffCounter = 1;
  const agentInstances = new Map<string, string>();
  const serviceCheckouts = new Map<string, { checkoutID: string; cartID: string }>();

  const carts: Record<string, Record<string, unknown>> = {};
  const serviceExecutions: Record<string, Record<string, unknown>> = {};
  const ordersByBuyer: Record<string, Array<Record<string, unknown>>> = {};
  let accountOrders: Array<Record<string, unknown>> = [];
  const orderByID: Record<string, Record<string, unknown>> = {};

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | undefined = undefined;
      if (text.length > 0) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "bad_request", message: "invalid JSON" }));
          return;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      requests.push({ method: req.method ?? "GET", path: req.url ?? "/", headers, body });
      handle(req, res);
    });
  });

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const bearer = (req.headers["authorization"] as string | undefined) ?? "";
    const path = url.pathname;

    res.setHeader("Content-Type", "application/json");

    if (method === "GET" && path === "/v1/readyz") {
      respond(res, 200, { status: "ready", version: "mock" });
      return;
    }

    if (method === "GET" && path === "/v1/catalog/manifest") {
      respond(res, 200, {
        version: "cat_mock",
        status: "published",
        item_count: 1,
        snapshot_id: "snap_mock",
        manifest: {
          items: [{
            catalog_item_id: "cat_service",
            slug: "qizhidao-company-lookup",
            title: "企知道企业查询",
            description: "Confirm the company identity before purchasing the primary report.",
            provider: "qizhidao",
            service_type: "company_lookup",
            category: "enterprise_data",
            service_flow: {
              discovery: {
                role: "subject_disambiguation",
                title: "Confirm company identity",
                description: "Use a keyword to identify the intended company; this is an auxiliary step.",
                capability_id: "fuzzy_disambiguation",
                free_quota_limit: 3,
                quota_subject: "agent_device",
                paid_continuation: {
                  capability_id: "fuzzy_disambiguation_paid",
                  description: "Continue after free quota without a delivery email.",
                  amount_minor: 10,
                  currency: "CNY",
                  delivery_email_required: false,
                },
              },
              primary_service: {
                capability_id: "precise_report",
                title: "Precise company report",
                description: "Purchase the complete report after confirming the company.",
                amount_minor: 50,
                currency: "CNY",
                delivery_email_required: true,
                delivery_description: "Email sends the protected result claim link.",
              },
            },
            variants: [{
              catalog_variant_id: "var_service",
              offer_id: "offer_service",
              title: "精准查询",
              amount_minor: 50,
              currency: "CNY",
            }],
          }],
        },
        published_at: "2026-07-05T12:00:00Z",
      });
      return;
    }

    if (method === "POST" && path === "/v1/agent-device-enrollments") {
      const payload = requests.at(-1)?.body ?? {};
      pendingAgentType = String(payload.agent_type ?? "codex-cli");
      respond(res, 201, { agent_device_enrollment_id: "enr_mock", challenge: "enroll_mock" });
      return;
    }

    if (method === "POST" && path === "/v1/agent-device-enrollments/enr_mock/verify") {
      const instanceID = `ain_${pendingAgentType.replaceAll("-", "_")}`;
      agentInstances.set(pendingAgentType, instanceID);
      respond(res, 200, {
        agent_device_id: "adev_mock",
        agent_device_key_id: "akey_mock",
        quota_lineage_id: "qln_mock",
        agent_instance_id: instanceID,
        agent_type: pendingAgentType,
      });
      return;
    }

    if (method === "POST" && path === "/v1/agent-instances") {
      const agentType = String(requests.at(-1)?.body?.agent_type ?? "codex-cli");
      const instanceID = `ain_${agentType.replaceAll("-", "_")}`;
      agentInstances.set(agentType, instanceID);
      respond(res, 201, { agent_instance_id: instanceID, agent_type: agentType });
      return;
    }

    if (method === "POST" && path === "/v1/agent-device-session-challenges") {
      const instanceID = String(requests.at(-1)?.body?.agent_instance_id ?? "");
      const agentType = [...agentInstances].find(([, value]) => value === instanceID)?.[0] ?? pendingAgentType;
      respond(res, 201, { agent_device_session_challenge_id: `ses_${agentType}`, challenge: `nonce_${agentType}` });
      return;
    }

    const sessionVerify = path.match(/^\/v1\/agent-device-session-challenges\/([^/]+)\/verify$/);
    if (method === "POST" && sessionVerify) {
      respond(res, 200, {
        session_token: `session_${sessionVerify[1]}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return;
    }

    if (method === "POST" && path === "/v1/carts") {
      const payload = (requests.at(-1)?.body ?? {}) as { currency?: string; items?: unknown[] };
      const cartID = `cart_${cartCounter++}`;
      const amountMinor = (payload.items?.length ?? 1) * 100;
      const firstItem = (payload.items?.[0] ?? {}) as { catalog_item_id?: string; catalog_variant_id?: string; offer_id?: string };
      const serviceExecutionID = firstItem.catalog_item_id === "cat_service" ? "se_mock_1" : undefined;
      if (serviceExecutionID) {
        serviceExecutions[serviceExecutionID] = mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability");
      }
      const cart = {
        cart_id: cartID,
        status: "active",
        amount_minor: amountMinor,
        currency: payload.currency ?? "CNY",
        items: [
          {
            cart_item_id: "ci_1",
            title: serviceExecutionID ? "企知道企业查询" : "Mock Item",
            quantity: 1,
            amount_minor: amountMinor,
            currency: payload.currency ?? "CNY",
            ...(firstItem.catalog_item_id ? { catalog_item_id: firstItem.catalog_item_id } : {}),
            ...(firstItem.catalog_variant_id ? { catalog_variant_id: firstItem.catalog_variant_id } : {}),
            ...(firstItem.offer_id ? { offer_id: firstItem.offer_id } : {}),
            ...(serviceExecutionID ? {
              service_execution_id: serviceExecutionID,
              service_capability_id: "precise_lookup",
              next_action: "invoke_capability",
              checkout_required: false,
            } : {}),
          },
        ],
      };
      carts[cartID] = cart;
      respond(res, 201, cart);
      return;
    }

    const cartItemAddMatch = path.match(/^\/v1\/carts\/([^/]+)\/items$/);
    if (method === "POST" && cartItemAddMatch) {
      const cartID = cartItemAddMatch[1]!;
      const payload = (requests.at(-1)?.body ?? {}) as { catalog_item_id?: string; catalog_variant_id?: string; offer_id?: string };
      const cart = carts[cartID] ?? {
        cart_id: cartID,
        status: "active",
        amount_minor: 0,
        currency: "CNY",
        items: [],
      };
      const serviceExecutionID = payload.catalog_item_id === "cat_service" ? "se_mock_1" : undefined;
      if (serviceExecutionID) {
        serviceExecutions[serviceExecutionID] = mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability");
      }
      (cart.items as Array<Record<string, unknown>>).push({
        cart_item_id: `ci_${(cart.items as unknown[]).length + 1}`,
        title: serviceExecutionID ? "企知道企业查询" : "Mock Item",
        quantity: 1,
        amount_minor: 100,
        currency: "CNY",
        catalog_item_id: payload.catalog_item_id,
        catalog_variant_id: payload.catalog_variant_id,
        offer_id: payload.offer_id,
        ...(serviceExecutionID ? {
          service_execution_id: serviceExecutionID,
          service_capability_id: "precise_lookup",
          next_action: "invoke_capability",
          checkout_required: false,
        } : {}),
      });
      carts[cartID] = cart;
      respond(res, 200, cart);
      return;
    }

    const cartGetMatch = path.match(/^\/v1\/carts\/([^/]+)$/);
    if (method === "GET" && cartGetMatch) {
      const cartID = cartGetMatch[1]!;
      respond(res, 200, carts[cartID] ?? {
        cart_id: cartID,
        status: "active",
        amount_minor: 0,
        currency: "CNY",
        items: [],
      });
      return;
    }

    const cartItemRemoveMatch = path.match(/^\/v1\/carts\/([^/]+)\/items\/([^/]+)$/);
    if (method === "DELETE" && cartItemRemoveMatch) {
      const cartID = cartItemRemoveMatch[1]!;
      const cart = {
        cart_id: cartID,
        status: "active",
        amount_minor: 0,
        currency: "CNY",
        items: [],
      };
      carts[cartID] = cart;
      respond(res, 200, cart);
      return;
    }

    const cartAbandonMatch = path.match(/^\/v1\/carts\/([^/]+)$/);
    if (method === "DELETE" && cartAbandonMatch) {
      const cartID = cartAbandonMatch[1]!;
      const cart = {
        cart_id: cartID,
        status: "abandoned",
        amount_minor: 0,
        currency: "CNY",
        items: [],
      };
      carts[cartID] = cart;
      respond(res, 200, cart);
      return;
    }

    if (method === "GET" && path === "/v1/service-executions") {
      respond(res, 200, { executions: Object.values(serviceExecutions) });
      return;
    }

    const serviceGetMatch = path.match(/^\/v1\/service-executions\/([^/]+)$/);
    if (method === "GET" && serviceGetMatch) {
      const serviceExecutionID = serviceGetMatch[1]!;
      respond(res, 200, serviceExecutions[serviceExecutionID] ?? mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability"));
      return;
    }

    const serviceInvokeMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/capabilities\/([^/]+)\/invoke$/);
    if (method === "POST" && serviceInvokeMatch) {
      const serviceExecutionID = serviceInvokeMatch[1]!;
      const capabilityID = serviceInvokeMatch[2]!;
      if (serviceExecutionID === "se_quota") {
        const quotaModel = mockServiceExecutionReadModel(serviceExecutionID, "create_checkout");
        quotaModel.execution = {
          ...(quotaModel.execution as Record<string, unknown>),
          status: "quota_exhausted",
          phase: "pre_purchase",
          current_capability_id: capabilityID,
        };
        serviceExecutions[serviceExecutionID] = quotaModel;
        respond(res, 200, {
          execution: quotaModel.execution,
          invocation: {
            service_capability_invocation_id: "sci_quota",
            service_execution_id: serviceExecutionID,
            capability_id: capabilityID,
            status: "quota_exhausted",
            created_at: "2026-07-11T00:00:00Z",
          },
          result_items: [],
          provider_called: false,
          effective_quota: {
            bucket: "company_lookup_fuzzy",
            subject_type: "device_lineage",
            limit: 3,
            remaining: 0,
            exhausted: true,
            replenishment: "purchase_finalized",
          },
          next_actions: [{ kind: "create_checkout", capability_id: "fuzzy_disambiguation_paid", requires_human: true }],
        });
        return;
      }
      const model = mockServiceExecutionReadModel(serviceExecutionID, "select_candidate");
      serviceExecutions[serviceExecutionID] = model;
      respond(res, 200, {
        execution: model.execution,
        invocation: {
          service_capability_invocation_id: "sci_1",
          service_execution_id: serviceExecutionID,
          capability_id: capabilityID,
          status: "completed",
          created_at: "2026-07-05T12:00:00Z",
        },
        result_items: model.result_items,
      });
      return;
    }

    const serviceActionMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/actions$/);
    if (method === "POST" && serviceActionMatch) {
      const serviceExecutionID = serviceActionMatch[1]!;
      const payload = (requests.at(-1)?.body ?? {}) as { action_type?: string; result_item_id?: string; selected_candidate_hash?: string };
      serviceExecutions[serviceExecutionID] = mockServiceExecutionReadModel(serviceExecutionID, "create_checkout");
      respond(res, 201, {
        service_execution_action_id: "sea_1",
        service_execution_id: serviceExecutionID,
        action_type: payload.action_type ?? "select_candidate",
        status: "pending",
        actor_type: "agent",
        result_item_id: payload.result_item_id,
        selected_candidate_hash: payload.selected_candidate_hash,
      });
      return;
    }

    if (method === "POST" && path === "/v1/checkouts") {
      const checkoutID = `chk_${checkoutCounter++}`;
      const payload = (requests.at(-1)?.body ?? {}) as { cart_id?: string; client_reference_id?: string };
      const checkoutURL = `https://sandbox.itpay.ai/checkout/${checkoutID}`;
      const displayToken = `cdt_${checkoutID}_secret`;
      respond(res, 201, {
        checkout: {
          checkout_id: checkoutID,
          status: "quote_bound",
          next_action: "open_checkout",
          amount_minor: 100,
          currency: "CNY",
        },
        checkout_url: checkoutURL,
        display_token: displayToken,
        qr_payload: `${checkoutURL}?display_token=${displayToken}`,
        qr_png_url: `/v1/checkouts/${checkoutID}/qr.png?display_token=${displayToken}`,
      });
      void payload;
      return;
    }

    const serviceCheckoutMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/checkout$/);
    if (method === "POST" && serviceCheckoutMatch) {
      const serviceExecutionID = serviceCheckoutMatch[1]!;
      const requestBody = (requests.at(-1)?.body ?? {}) as { resume?: boolean };
      const existing = serviceCheckouts.get(serviceExecutionID);
      const checkoutID = existing?.checkoutID ?? `chk_${checkoutCounter++}`;
      const cartID = existing?.cartID ?? `cart_${cartCounter++}`;
      serviceCheckouts.set(serviceExecutionID, { checkoutID, cartID });
      const checkoutURL = `https://sandbox.itpay.ai/checkout/${checkoutID}`;
      const displayToken = `cdt_${checkoutID}_${serviceHandoffCounter++}`;
      respond(res, requestBody.resume ? 200 : 201, {
        service_quote_lock_id: `sqlock_${serviceExecutionID}`,
        handoff_reissued: Boolean(requestBody.resume),
        cart: {
          cart_id: cartID,
          status: "active",
          amount_minor: 50,
          currency: "CNY",
          items: [{
            title: "企知道企业精准报告",
            quantity: 1,
            amount_minor: 50,
            currency: "CNY",
            service_execution_id: serviceExecutionID,
            service_capability_id: "precise_report",
          }],
        },
        checkout: {
          checkout: {
            checkout_id: checkoutID,
            status: "quote_bound",
            next_action: "open_checkout",
            amount_minor: 50,
            currency: "CNY",
          },
          checkout_url: checkoutURL,
          display_token: displayToken,
          qr_payload: `${checkoutURL}?display_token=${displayToken}`,
          qr_png_url: `/v1/checkouts/${checkoutID}/qr.png?display_token=${displayToken}`,
        },
        binding: {
          service_checkout_binding_id: `scb_${checkoutID}`,
          service_execution_id: serviceExecutionID,
          service_quote_lock_id: `sqlock_${serviceExecutionID}`,
          checkout_id: checkoutID,
          status: "checkout_pending",
        },
      });
      return;
    }

    const grantedResultMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/granted-result$/);
    if (method === "GET" && grantedResultMatch) {
      const serviceExecutionID = grantedResultMatch[1]!;
      respond(res, 200, {
        service_execution_id: serviceExecutionID,
        vault_artifact_id: `vault_${serviceExecutionID}`,
        agent_read_grant_id: `grant_${serviceExecutionID}`,
        grant_status: "active",
        result: { summary: "granted" },
      });
      return;
    }

    const qrPNGMatch = path.match(/^\/v1\/checkouts\/([^/]+)\/qr\.png$/);
    if (method === "GET" && qrPNGMatch) {
      // 16x16 transparent PNG so the IDE image viewer has something to
      // render. Bigger images would force smoke fixtures to allocate
      // larger buffers every test run.
      const png = Buffer.from(BRAND_PNG_BASE64, "base64");
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
      });
      res.end(png);
      return;
    }

    const presentationMatch = path.match(/^\/v1\/checkouts\/([^/]+)\/presentation$/);
    if (method === "GET" && presentationMatch) {
      const checkoutID = presentationMatch[1];
      if (url.searchParams.get("display_token") === "cdt_expired") {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
      respond(res, 200, {
        checkout: {
          checkout_id: checkoutID,
          status: "quote_bound",
          next_action: "open_checkout",
          amount_minor: 100,
          currency: "CNY",
        },
        items: [{ title: "Mock Item", quantity: 1, amount_minor: 100, currency: "CNY" }],
        payment_intents: [],
        buyer_session: { state: "anonymous" },
      });
      return;
    }

    const piMatch = path.match(/^\/v1\/checkouts\/([^/]+)\/payment-intents$/);
    if (method === "POST" && piMatch) {
      const checkoutID = piMatch[1];
      const intentID = `pi_${paymentIntentCounter++}`;
      const orderID = `ord_${orderCounter++}`;
      const buyerID = "buyer_test";
      const order = {
        order_id: orderID,
        checkout_id: checkoutID,
        status: "delivery_pending",
        amount_minor: 100,
        currency: "CNY",
        paid_at: "2026-07-05T12:00:00Z",
        items: [{ title: "Mock Item", quantity: 1, amount_minor: 100, currency: "CNY" }],
        delivery_artifacts: [
          {
            delivery_artifact_id: `da_${orderID}`,
            order_id: orderID,
            status: "claimable",
            artifact_type: "link",
            sensitive_content_redacted: true,
          },
        ],
      };
      orderByID[orderID] = order;
      (ordersByBuyer[buyerID] ??= []).push(order);
      accountOrders = ordersByBuyer[buyerID]!;
      respond(res, 202, {
        payment_intent_id: intentID,
        checkout_id: checkoutID,
        status: "waiting_user_payment",
        payment_method_type: "alipay",
        amount_minor: 100,
        currency: "CNY",
      });
      return;
    }

    const orderMatch = path.match(/^\/v1\/orders\/([^/]+)$/);
    if (method === "GET" && orderMatch) {
      const orderID = orderMatch[1]!;
      const order = orderByID[orderID];
      if (!order) {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
      respond(res, 200, order);
      return;
    }

    if (method === "GET" && path === "/v1/me/orders") {
      if (!bearer.startsWith("Bearer ")) {
        respond(res, 401, { code: "session_required", message: "missing bearer" });
        return;
      }
      const token = bearer.slice("Bearer ".length);
      if (token !== "account_token") {
        respond(res, 403, { code: "account_scope_required", message: "order scope is not enough" });
        return;
      }
      respond(res, 200, { orders: accountOrders });
      return;
    }

    const refundMatch = path.match(/^\/v1\/orders\/([^/]+)\/refunds$/);
    if (method === "POST" && refundMatch) {
	  if (bearer !== "Bearer account_token" && !bearer.startsWith("ItPayDevice ")) {
        respond(res, 401, { code: "session_required", message: "account bearer required" });
        return;
      }
      const orderID = refundMatch[1]!;
      const payload = (requests.at(-1)?.body ?? {}) as { reason?: string };
      respond(res, 202, {
        refund_request_id: `rr_${refundCounter++}`,
        order_id: orderID,
		status: "accepted",
        amount_minor: 100,
        currency: "CNY",
        reason: payload.reason,
		decision_mode: "automatic",
		consumption_state: "unconsumed",
		access_locked: true,
		can_cancel: true,
      });
      return;
    }

	const refundReadMatch = path.match(/^\/v1\/refunds\/([^/]+)$/);
	if (method === "GET" && refundReadMatch) {
		respond(res, 200, { refund_request_id: refundReadMatch[1], order_id: "ord_42", status: "accepted", amount_minor: 100, currency: "CNY", decision_mode: "automatic", consumption_state: "unconsumed", access_locked: true, can_cancel: true });
		return;
	}
	const refundCancelMatch = path.match(/^\/v1\/refunds\/([^/]+)\/cancel$/);
	if (method === "POST" && refundCancelMatch) {
		respond(res, 200, { refund_request_id: refundCancelMatch[1], order_id: "ord_42", status: "cancelled", amount_minor: 100, currency: "CNY", decision_mode: "automatic", consumption_state: "unconsumed", access_locked: false, can_cancel: false });
		return;
	}

    respond(res, 404, { code: "not_found", message: `no mock for ${method} ${path}` });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function mockServiceExecutionReadModel(serviceExecutionID: string, nextAction: string): Record<string, unknown> {
  const checkoutRequired = nextAction === "create_checkout";
  return {
    execution: {
      service_execution_id: serviceExecutionID,
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "sdcv_mock",
      compiled_service_graph_id: "csg_mock",
      agent_device_id: "agent_smoke",
      status: checkoutRequired ? "quote_locked" : "running",
      phase: checkoutRequired ? "quote" : "pre_purchase",
      current_capability_id: checkoutRequired ? "precise_lookup" : "fuzzy_disambiguation",
      checkout_required: checkoutRequired,
      next_action: nextAction,
      started_at: "2026-07-05T12:00:00Z",
      created_at: "2026-07-05T12:00:00Z",
      updated_at: "2026-07-05T12:00:00Z",
    },
    capabilities: [
      {
        capability_id: "fuzzy_disambiguation",
        phase: "pre_purchase",
        agent_visible: true,
        requires_payment: false,
        requires_human_action: false,
        vault_required: false,
        delivery_email_required: false,
        free_quota_limit: 3,
        quota_subject: "agent_device",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
      {
        capability_id: "precise_lookup",
        phase: "paid_delivery",
        agent_visible: false,
        requires_payment: true,
        requires_human_action: true,
        vault_required: true,
        delivery_email_required: true,
        price_amount_minor: 50,
        price_currency: "CNY",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
      {
        capability_id: "precise_report",
        phase: "paid_fulfillment",
        agent_visible: false,
        requires_payment: true,
        requires_human_action: false,
        vault_required: true,
        delivery_email_required: true,
        price_amount_minor: 50,
        price_currency: "CNY",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
      {
        capability_id: "fuzzy_disambiguation_paid",
        phase: "paid_fulfillment",
        agent_visible: true,
        requires_payment: true,
        requires_human_action: false,
        vault_required: false,
        delivery_email_required: false,
        price_amount_minor: 10,
        price_currency: "CNY",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
      },
    ],
    events: [],
    result_items: nextAction === "select_candidate"
      ? [{
          service_capability_result_item_id: "scri_1",
          service_execution_id: serviceExecutionID,
          capability_id: "fuzzy_disambiguation",
          stable_hash: "hash_candidate_1",
          rank: 1,
          display_title: "小米汽车科技有限公司",
          safe_payload: { company_name: "小米汽车科技有限公司" },
          created_at: "2026-07-05T12:00:00Z",
        }]
      : [],
    actions: [],
    checkout_bindings: [],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: [],
    graph_projection: [],
    refunds: [],
  };
}
