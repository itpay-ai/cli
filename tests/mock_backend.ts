// Minimal V3 mock backend used by the CLI smoke test. It implements just
// enough of the V3 surface to exercise the CLI command flow end to end:
//   readyz, carts, checkouts, payment-intents, orders, me/orders, refunds
//
// The mock records every request so tests can assert headers (Bearer,
// Idempotency-Key) and body shapes. DTOs intentionally mirror the Go
// presenters in services/backend/internal/presenter/*.go.

import http from "node:http";
import { AddressInfo } from "node:net";
import { API_CONTRACT_REVISION, CLI_VERSION } from "../src/state/config.js";

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
  setAccountOrders: (orders: Array<Record<string, unknown>>) => void;
  setServiceError: (error?: {
    status: number; code: string; message: string;
    service_execution_id?: string; provider_called?: boolean;
    effective_quota?: { bucket: string; subject_type: string; limit: number; remaining: number; exhausted: boolean; replenishment: string };
  }) => void;
  close: () => Promise<void>;
}

export async function startMockBackend(): Promise<MockBackendHandle> {
  const requests: RecordedRequest[] = [];

  // Mutable state simulating a tiny slice of the V3 backend.
  let cartCounter = 1;
  let checkoutCounter = 1;
  let paymentIntentCounter = 1;
  let refundCounter = 1;
  let serviceExecutionCounter = 1;
  let pendingAgentType = "codex-cli";
  let serviceHandoffCounter = 1;
  const agentInstances = new Map<string, string>();
  const serviceCheckouts = new Map<string, { checkoutID: string; cartID: string; capabilityID: string; lockedInput: Record<string, unknown> }>();
	const serviceQuotes = new Map<string, { serviceExecutionID: string; capabilityID: string; amountMinor: number }>();

  const carts: Record<string, Record<string, unknown>> = {};
  const serviceExecutions: Record<string, Record<string, unknown>> = {};
  let accountOrders: Array<Record<string, unknown>> = [];
  let serviceError: Parameters<MockBackendHandle["setServiceError"]>[0];
  const orderByID: Record<string, Record<string, unknown>> = {
    ord_delivery: {
      order_id: "ord_delivery", order_code: "IP-DELIVERY", checkout_id: "chk_delivery", status: "delivered",
      amount_minor: 50, currency: "CNY", created_at: "2026-07-13T12:00:00Z", paid_at: "2026-07-13T12:00:00Z",
      items: [{ title: "Protected result", quantity: 1, amount_minor: 50, currency: "CNY" }],
      delivery_artifacts: [{
        delivery_artifact_id: "da_delivery", order_id: "ord_delivery", service_execution_id: "se_granted",
        vault_artifact_id: "vault_se_granted", status: "claimable", artifact_type: "service_result",
        sensitive_content_redacted: true,
      }],
    },
    ord_agent_visible: {
      order_id: "ord_agent_visible", order_code: "IP-VISIBLE", checkout_id: "chk_visible", status: "delivered",
      amount_minor: 10, currency: "CNY", created_at: "2026-07-13T12:00:00Z", paid_at: "2026-07-13T12:00:00Z",
      items: [{ title: "Agent-visible result", quantity: 1, amount_minor: 10, currency: "CNY" }],
      delivery_artifacts: [],
    },
    ord_locked: {
      order_id: "ord_locked", order_code: "IP-LOCKED", checkout_id: "chk_locked", status: "delivered",
      amount_minor: 50, currency: "CNY", created_at: "2026-07-13T12:00:00Z", paid_at: "2026-07-13T12:00:00Z",
      items: [{ title: "Locked result", quantity: 1, amount_minor: 50, currency: "CNY" }],
      delivery_artifacts: [{
        delivery_artifact_id: "da_locked", order_id: "ord_locked", service_execution_id: "se_vault_denied",
        vault_artifact_id: "vault_locked", status: "claimable", artifact_type: "service_result",
        sensitive_content_redacted: true,
      }],
    },
  };

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

    if (serviceError && path.startsWith("/v1/service-executions")) {
      const { status, ...body } = serviceError;
      respond(res, status, body);
      return;
    }

    if (method === "GET" && path === "/v1/readyz") {
      respond(res, 200, { status: "ready", version: "mock" });
      return;
    }

    if (method === "GET" && path === "/v1/platform/compatibility") {
      respond(res, 200, {
        platform_revision: "v3.mock",
        schema_revision: "sha256:mock",
        bootstrap_revision: "mock",
        api_contract_revision: API_CONTRACT_REVISION,
        minimum_cli_version: CLI_VERSION,
        maximum_cli_major: 2,
      });
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
            service_id: "svc_qizhidao_company_lookup",
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
			const firstItem = (payload.items?.[0] ?? {}) as { service_quote_lock_id?: string; catalog_item_id?: string; catalog_variant_id?: string; offer_id?: string };
			const quote = firstItem.service_quote_lock_id ? serviceQuotes.get(firstItem.service_quote_lock_id) : undefined;
			const amountMinor = quote?.amountMinor ?? (payload.items?.length ?? 1) * 100;
			const serviceExecutionID = quote?.serviceExecutionID ?? (firstItem.catalog_item_id === "cat_service" ? "se_mock_1" : undefined);
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
						...(firstItem.service_quote_lock_id ? { service_quote_lock_id: firstItem.service_quote_lock_id } : {}),
						service_capability_id: quote?.capabilityID ?? "precise_lookup",
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
			const payload = (requests.at(-1)?.body ?? {}) as { service_quote_lock_id?: string; catalog_item_id?: string; catalog_variant_id?: string; offer_id?: string };
      const cart = carts[cartID] ?? {
        cart_id: cartID,
        status: "active",
        amount_minor: 0,
        currency: "CNY",
        items: [],
      };
			const quote = payload.service_quote_lock_id ? serviceQuotes.get(payload.service_quote_lock_id) : undefined;
			const serviceExecutionID = quote?.serviceExecutionID ?? (payload.catalog_item_id === "cat_service" ? "se_mock_1" : undefined);
      if (serviceExecutionID) {
        serviceExecutions[serviceExecutionID] = mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability");
      }
      (cart.items as Array<Record<string, unknown>>).push({
        cart_item_id: `ci_${(cart.items as unknown[]).length + 1}`,
        title: serviceExecutionID ? "企知道企业查询" : "Mock Item",
        quantity: 1,
		amount_minor: quote?.amountMinor ?? 100,
        currency: "CNY",
        catalog_item_id: payload.catalog_item_id,
        catalog_variant_id: payload.catalog_variant_id,
        offer_id: payload.offer_id,
				...(serviceExecutionID ? {
					service_execution_id: serviceExecutionID,
					...(payload.service_quote_lock_id ? { service_quote_lock_id: payload.service_quote_lock_id } : {}),
					service_capability_id: quote?.capabilityID ?? "precise_lookup",
          next_action: "invoke_capability",
          checkout_required: false,
        } : {}),
			});
			cart.amount_minor = (cart.items as Array<{ amount_minor: number }>).reduce((sum, item) => sum + item.amount_minor, 0);
      carts[cartID] = cart;
      respond(res, 200, cart);
      return;
    }

    const cartGetMatch = path.match(/^\/v1\/carts\/([^/]+)$/);
    if (method === "GET" && cartGetMatch) {
      const cartID = cartGetMatch[1]!;
      if (cartID === "cart_missing") {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
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

    if (method === "POST" && path === "/v1/service-executions") {
      const serviceExecutionID = `se_started_${serviceExecutionCounter++}`;
      const model = mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability");
      serviceExecutions[serviceExecutionID] = model;
      respond(res, 201, {
        execution: model.execution,
        capabilities: model.capabilities,
        graph_id: "csg_mock",
      });
      return;
    }

    if (method === "GET" && path === "/v1/service-executions") {
      respond(res, 200, { executions: Object.values(serviceExecutions) });
      return;
    }

    const serviceEventsMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/events$/);
    if (method === "GET" && serviceEventsMatch) {
      const serviceExecutionID = serviceEventsMatch[1]!;
      if (serviceExecutionID === "se_missing") {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
      const afterSequence = Number(url.searchParams.get("after_sequence") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const events = Array.from({ length: 6 }, (_, index) => ({
        service_execution_event_id: `see_secret_${index + 1}`,
        service_execution_id: serviceExecutionID,
        sequence: index + 1,
        type: index === 5 ? "delivery.issued" : "capability.progressed",
        status: index === 5 ? "delivery_issued" : "running",
        phase: index === 5 ? "delivery" : "pre_purchase",
        capability_id: "generic_capability",
        redacted_summary: {
          provider_header: "must_not_leak",
          selected_candidate_hash: "must_not_leak",
        },
        occurred_at: `2026-07-13T12:0${index}:00Z`,
      })).filter((event) => event.sequence > afterSequence).slice(0, limit);
      respond(res, 200, { events });
      return;
    }

    const serviceGetMatch = path.match(/^\/v1\/service-executions\/([^/]+)$/);
    if (method === "GET" && serviceGetMatch) {
      const serviceExecutionID = serviceGetMatch[1]!;
      if (serviceExecutionID === "se_missing") {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
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
      if (serviceExecutionID === "se_empty") {
        const model = mockServiceExecutionReadModel(serviceExecutionID, "invoke_capability");
        model.execution = { ...(model.execution as Record<string, unknown>), status: "completed", next_action: "none" };
        serviceExecutions[serviceExecutionID] = model;
        respond(res, 200, {
          execution: model.execution,
          invocation: {
            service_capability_invocation_id: "sci_empty", service_execution_id: serviceExecutionID,
            capability_id: capabilityID, status: "succeeded", created_at: "2026-07-19T12:00:00Z",
          },
          result_items: [], provider_called: true,
          effective_quota: {
            bucket: "company_name_suggestion", subject_type: "device_lineage", limit: 3,
            remaining: 1, exhausted: false, replenishment: "purchase_finalized",
          },
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
			const payload = (requests.at(-1)?.body ?? {}) as { action_type?: string; actor_type?: string; status?: string; result_item_id?: string };
			const selected = mockServiceExecutionReadModel(serviceExecutionID, "create_checkout");
			selected.execution = {
				...(selected.execution as Record<string, unknown>),
				status: "human_action_approved",
				phase: "pre_purchase",
				current_capability_id: "fuzzy_disambiguation",
				checkout_required: false,
				next_action: "create_checkout",
			};
			selected.allowed_actions = [{
				type: "prepare_quote",
				capability_id: "precise_report",
				source_capability_id: "fuzzy_disambiguation",
				requires_human: false,
			}];
			serviceExecutions[serviceExecutionID] = selected;
      respond(res, 201, {
        service_execution_action_id: "sea_1",
        service_execution_id: serviceExecutionID,
        action_type: payload.action_type ?? "select_candidate",
        status: payload.status ?? "pending",
        actor_type: payload.actor_type ?? "agent",
        result_item_id: payload.result_item_id,
      });
      return;
    }

		const serviceQuoteMatch = path.match(/^\/v1\/service-executions\/([^/]+)\/quotes$/);
		if (method === "POST" && serviceQuoteMatch) {
			const serviceExecutionID = serviceQuoteMatch[1]!;
			const payload = (requests.at(-1)?.body ?? {}) as { capability_id?: string };
			const capabilityID = payload.capability_id ?? "precise_report";
			const quoteID = `sqlock_${serviceExecutionID}_${capabilityID}`;
			const amountMinor = capabilityID.includes("fuzzy") ? 10 : 50;
			serviceQuotes.set(quoteID, { serviceExecutionID, capabilityID, amountMinor });
			respond(res, 201, {
				service_quote_lock_id: quoteID,
				service_execution_id: serviceExecutionID,
				capability_id: capabilityID,
				amount_minor: amountMinor,
				currency: "CNY",
				expires_at: "2026-07-13T12:15:00Z",
			});
			return;
		}

    if (method === "POST" && path === "/v1/checkouts") {
      const checkoutID = `chk_${checkoutCounter++}`;
      const payload = (requests.at(-1)?.body ?? {}) as { cart_id?: string; client_reference_id?: string };
			const cart = payload.cart_id ? carts[payload.cart_id] : undefined;
			const checkoutURL = `https://sandbox.itpay.ai/checkout/${checkoutID}`;
      const displayToken = `cdt_${checkoutID}_secret`;
      respond(res, 201, {
        checkout: {
          checkout_id: checkoutID,
          status: "quote_bound",
          next_action: "open_checkout",
					amount_minor: Number(cart?.amount_minor ?? 100),
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
      const requestBody = (requests.at(-1)?.body ?? {}) as {
        resume?: boolean;
        capability_id?: string;
        locked_input?: Record<string, unknown>;
      };
      const existing = serviceCheckouts.get(serviceExecutionID);
      const checkoutID = existing?.checkoutID ?? `chk_${checkoutCounter++}`;
      const cartID = existing?.cartID ?? `cart_${cartCounter++}`;
      const capabilityID = requestBody.capability_id ?? existing?.capabilityID ?? "precise_report";
      const lockedInput = requestBody.locked_input ?? existing?.lockedInput ?? {};
      serviceCheckouts.set(serviceExecutionID, { checkoutID, cartID, capabilityID, lockedInput });
      const checkoutURL = `https://sandbox.itpay.ai/checkout/${checkoutID}`;
      const displayToken = `cdt_${checkoutID}_${serviceHandoffCounter++}`;
      respond(res, requestBody.resume ? 200 : 201, {
        service_quote_lock_id: `sqlock_${serviceExecutionID}`,
        capability_id: capabilityID,
        locked_input: lockedInput,
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
            service_capability_id: capabilityID,
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
      if (serviceExecutionID === "se_vault_none" || serviceExecutionID === "se_vault_denied") {
        respond(res, 403, { code: "agent_access_denied", message: "an active agent read grant is required" });
        return;
      }
      respond(res, 200, {
        service_execution_id: serviceExecutionID,
        vault_artifact_id: `vault_${serviceExecutionID}`,
        agent_read_grant_id: `grant_${serviceExecutionID}`,
        grant_status: "active",
        expires_at: "2026-07-13T12:15:00Z",
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
      const serviceCheckoutEntry = [...serviceCheckouts.entries()].find(([, checkout]) => checkout.checkoutID === checkoutID);
      const serviceExecutionID = serviceCheckoutEntry?.[0];
      const serviceCheckout = serviceCheckoutEntry?.[1];
      if (url.searchParams.get("display_token") === "cdt_expired") {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
      if (checkoutID === "chk_completed") {
        respond(res, 200, {
          checkout: {
            checkout_id: checkoutID,
            status: "completed",
            next_action: "none",
            amount_minor: 50,
            currency: "CNY",
          },
          items: [{
            title: "Mock Service Result",
            quantity: 1,
            amount_minor: 50,
            currency: "CNY",
            service_execution_id: "se_completed",
          }],
          payment_intents: [{
            payment_intent_id: "pi_completed",
            checkout_id: checkoutID,
            status: "verified",
            payment_method_type: "alipay",
            amount_minor: 50,
            currency: "CNY",
          }],
          buyer_session: { state: "account" },
          completed_order_id: "ord_completed",
        });
        return;
      }
      respond(res, 200, {
        checkout: {
          checkout_id: checkoutID,
          status: "quote_bound",
          next_action: "open_checkout",
          amount_minor: serviceCheckout ? 50 : 100,
          currency: "CNY",
        },
        items: [{
          title: serviceCheckout ? "企知道企业精准报告" : "Mock Item",
          quantity: 1,
          amount_minor: serviceCheckout ? 50 : 100,
          currency: "CNY",
          ...(serviceCheckout ? {
            service_execution_id: serviceExecutionID,
            service_capability_id: serviceCheckout.capabilityID,
          } : {}),
        }],
        payment_intents: [],
        buyer_session: { state: "anonymous" },
      });
      return;
    }

    const piMatch = path.match(/^\/v1\/checkouts\/([^/]+)\/payment-intents$/);
    if (method === "POST" && piMatch) {
      const checkoutID = piMatch[1];
      const intentID = `pi_${paymentIntentCounter++}`;
      const paymentMethod = String(requests.at(-1)?.body?.payment_method_type ?? "alipay");
      const status = checkoutID?.includes("verified") ? "verified" : checkoutID?.includes("refunded") ? "refunded" : "waiting_user_payment";
      const action = checkoutID?.includes("qr_only")
        ? { qr_image_url: `https://qr.alipay.com/mock-${intentID}` }
        : checkoutID?.includes("wallet_only")
          ? { mobile_wallet_url: `alipays://platformapi/startapp?payment_intent_id=${intentID}` }
          : {
              qr_image_url: `https://qr.alipay.com/mock-${intentID}`,
              mobile_wallet_url: `alipays://platformapi/startapp?payment_intent_id=${intentID}`,
            };
      respond(res, 202, {
        payment_intent_id: intentID,
        checkout_id: checkoutID,
        status,
        payment_method_type: paymentMethod,
        amount_minor: 100,
        currency: "CNY",
        ...(status === "waiting_user_payment" ? { action } : {}),
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

    const orderDeliveryAccessMatch = path.match(/^\/v1\/orders\/([^/]+)\/delivery-access$/);
    if (method === "GET" && orderDeliveryAccessMatch) {
      const orderID = orderDeliveryAccessMatch[1]!;
      if (!orderByID[orderID]) {
        respond(res, 404, { code: "not_found", message: "resource not found" });
        return;
      }
      const agentVisible = orderID === "ord_agent_visible";
      respond(res, 200, {
        order_id: orderID,
        service_execution_id: agentVisible ? "se_agent_visible" : orderID === "ord_locked" ? "se_vault_denied" : "se_granted",
        ...(agentVisible ? {} : { delivery_artifact_id: `da_${orderID.replace("ord_", "")}`, vault_artifact_id: `vault_${orderID.replace("ord_", "")}` }),
        status: "completed",
        delivery_mode: agentVisible ? "agent_visible_result" : "vault_artifact",
      });
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
    if (method === "GET" && refundMatch) {
      const orderID = refundMatch[1]!;
      respond(res, 200, { refunds: orderID === "ord_locked" ? [{
        refund_request_id: "rr_locked", order_id: orderID, status: "accepted", amount_minor: 50, currency: "CNY",
        decision_mode: "automatic", consumption_state: "unconsumed", access_locked: true, can_cancel: true,
        created_at: "2026-07-13T12:00:00Z",
      }] : [] });
      return;
    }
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
		created_at: "2026-07-13T12:00:00Z",
      });
      return;
    }

	const refundReadMatch = path.match(/^\/v1\/refunds\/([^/]+)$/);
	if (method === "GET" && refundReadMatch) {
		if (refundReadMatch[1] === "rr_missing") {
			respond(res, 404, { code: "not_found", message: "resource not found" });
			return;
		}
		const succeeded = refundReadMatch[1] === "rr_succeeded";
		const manual = refundReadMatch[1] === "rr_manual";
		respond(res, 200, {
			refund_request_id: refundReadMatch[1], order_id: "ord_42",
			status: succeeded ? "succeeded" : manual ? "policy_review_required" : "accepted",
			amount_minor: 100, currency: "CNY",
			decision_mode: manual ? "manual" : "automatic",
			consumption_state: manual ? "consumed" : "unconsumed",
			access_locked: true, can_cancel: !succeeded,
			created_at: "2026-07-13T12:00:00Z",
		});
		return;
	}
	const refundCancelMatch = path.match(/^\/v1\/refunds\/([^/]+)\/cancel$/);
	if (method === "POST" && refundCancelMatch) {
		if (refundCancelMatch[1] === "rr_too_late") {
			respond(res, 409, { code: "refund_cancellation_too_late", message: "refund cancellation is too late" });
			return;
		}
		respond(res, 200, { refund_request_id: refundCancelMatch[1], order_id: "ord_42", status: "cancelled", amount_minor: 100, currency: "CNY", decision_mode: "automatic", consumption_state: "unconsumed", access_locked: false, can_cancel: false, created_at: "2026-07-13T12:00:00Z" });
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
    setAccountOrders: (orders) => { accountOrders = orders; },
    setServiceError: (error) => { serviceError = error; },
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
  const agentVisible = serviceExecutionID === "se_agent_visible";
  const refundLocked = serviceExecutionID === "se_refund_locked";
  const vaultDelivery = serviceExecutionID === "se_granted" || serviceExecutionID === "se_vault_none" || serviceExecutionID === "se_vault_denied" || refundLocked;
  const grantActive = serviceExecutionID === "se_granted";
  return {
    execution: {
      service_execution_id: serviceExecutionID,
      service_id: "svc_qizhidao_company_lookup",
      service_contract_version_id: "sdcv_mock",
      compiled_service_graph_id: "csg_mock",
      agent_device_id: "agent_smoke",
		status: agentVisible ? "completed" : vaultDelivery ? (grantActive ? "grant_available" : "delivery_issued") : checkoutRequired ? "quote_locked" : nextAction === "select_candidate" ? "human_action_required" : "running",
      phase: agentVisible ? "completed" : vaultDelivery ? "delivery" : checkoutRequired ? "quote" : "pre_purchase",
      current_capability_id: agentVisible ? "public_result" : checkoutRequired ? "precise_lookup" : "fuzzy_disambiguation",
      checkout_required: checkoutRequired,
      next_action: agentVisible ? "completed" : vaultDelivery ? "view_delivery" : nextAction,
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
        requires_human_action: true,
        vault_required: false,
        delivery_email_required: false,
        free_quota_limit: 3,
        quota_subject: "agent_device",
        input_schema: { type: "object", required: ["keyword"] },
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
        delivery_email_purpose: "claim",
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
        delivery_email_purpose: "claim",
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
        input_schema: { type: "object", required: ["keyword"] },
        output_schema: { type: "object" },
      },
    ],
    events: serviceExecutionID === "se_timeline"
      ? Array.from({ length: 25 }, (_, index) => ({
          service_execution_event_id: `see_${index + 1}`,
          service_execution_id: serviceExecutionID,
          sequence: index + 1,
          type: index === 24 ? "delivery.issued" : "capability.progressed",
          status: index === 24 ? "delivery_issued" : "running",
          phase: index === 24 ? "delivery" : "pre_purchase",
          capability_id: "generic_capability",
          redacted_summary: { internal_ref: "must_not_leak" },
          occurred_at: `2026-07-13T12:${String(index).padStart(2, "0")}:00Z`,
        }))
      : [],
    result_items: agentVisible
      ? [{
          service_capability_result_item_id: "scri_visible_1",
          service_execution_id: serviceExecutionID,
          capability_id: "public_result",
          rank: 1,
          display_title: "Example result",
          safe_payload: { name: "Example result", status: "active" },
          created_at: "2026-07-13T12:00:00Z",
        }]
      : nextAction === "select_candidate"
      ? [{
          service_capability_result_item_id: "scri_1",
          service_execution_id: serviceExecutionID,
          capability_id: "fuzzy_disambiguation",
          rank: 1,
          display_title: "小米汽车科技有限公司",
          safe_payload: { company_name: "小米汽车科技有限公司" },
          created_at: "2026-07-05T12:00:00Z",
        }]
		: [],
	current_result_items: agentVisible
		? [{
				service_capability_result_item_id: "scri_visible_1",
				service_execution_id: serviceExecutionID,
				capability_id: "public_result",
				rank: 1,
				display_title: "Example result",
				safe_payload: { name: "Example result", status: "active" },
				created_at: "2026-07-13T12:00:00Z",
			}]
		: nextAction === "select_candidate"
			? [{
					service_capability_result_item_id: "scri_1",
					service_execution_id: serviceExecutionID,
					capability_id: "fuzzy_disambiguation",
					rank: 1,
					display_title: "小米汽车科技有限公司",
					safe_payload: { company_name: "小米汽车科技有限公司" },
					created_at: "2026-07-05T12:00:00Z",
				}]
			: [],
	allowed_actions: vaultDelivery || agentVisible
		? []
		: nextAction === "select_candidate"
			? [{ type: "select_candidate", source_capability_id: "fuzzy_disambiguation", requires_human: true }]
			: checkoutRequired
				? [{ type: "prepare_quote", capability_id: "precise_lookup", source_capability_id: "fuzzy_disambiguation", requires_human: false }]
				: [{ type: "invoke_capability", capability_id: "fuzzy_disambiguation", requires_human: false }],
    actions: [],
    checkout_bindings: [],
    payment_bindings: [],
    execution_requests: [],
    provider_invocations: [],
    delivery_bindings: agentVisible
      ? [{
          service_delivery_binding_id: "sdb_visible",
          service_execution_id: serviceExecutionID,
          order_id: "ord_visible",
          status: "completed",
          redacted_summary: { delivery_mode: "agent_visible_result" },
        }]
      : vaultDelivery
        ? [{
            service_delivery_binding_id: "sdb_vault",
            service_execution_id: serviceExecutionID,
            order_id: "ord_vault",
            vault_artifact_id: `vault_${serviceExecutionID}`,
            ...(grantActive ? { agent_read_grant_id: `grant_${serviceExecutionID}` } : {}),
            status: grantActive ? "grant_available" : "delivery_issued",
            grant_status: grantActive ? "active" : "missing",
            ...(grantActive ? { grant_expires_at: "2026-07-13T12:15:00Z" } : {}),
            redacted_summary: { delivery_mode: "vault_artifact" },
          }]
        : [],
	current_delivery: agentVisible
		? {
				service_delivery_binding_id: "sdb_visible", service_execution_id: serviceExecutionID,
				capability_id: "public_result", order_id: "ord_visible", status: "completed",
				redacted_summary: { delivery_mode: "agent_visible_result" },
			}
		: vaultDelivery
			? {
					service_delivery_binding_id: "sdb_vault", service_execution_id: serviceExecutionID,
					capability_id: "precise_report", order_id: "ord_vault", vault_artifact_id: `vault_${serviceExecutionID}`,
					...(grantActive ? { agent_read_grant_id: `grant_${serviceExecutionID}` } : {}),
					status: grantActive ? "grant_available" : "delivery_issued",
					grant_status: grantActive ? "active" : "missing",
					...(grantActive ? { grant_expires_at: "2026-07-13T12:15:00Z" } : {}),
					redacted_summary: { delivery_mode: "vault_artifact" },
				}
			: undefined,
    graph_projection: [],
    refunds: refundLocked ? [{
      refund_request_id: "rr_locked",
      order_id: "ord_vault",
      status: "policy_review_required",
      amount_minor: 50,
      currency: "CNY",
      decision_mode: "manual",
      consumption_state: "consumed",
      access_locked: true,
      can_cancel: true,
      created_at: "2026-07-13T12:00:00Z",
    }] : [],
  };
}
