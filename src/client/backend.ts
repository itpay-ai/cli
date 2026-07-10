// V3 endpoint wrappers. One function per route family; one file per domain.
// Keep parameter shapes aligned with the typed request DTOs in ./types.ts.

import type { HttpClient } from "./http.js";
import type {
  Cart,
  AddCartItemRequest,
  CheckoutCreated,
  CheckoutPresentation,
  CreateCartRequest,
  CreateCheckoutRequest,
  CreatePaymentIntentRequest,
  CreateRefundRequest,
  CreateServiceExecutionCheckoutRequest,
  CatalogManifest,
  InvokeServiceCapabilityRequest,
  ListOrdersResponse,
  ListServiceExecutionsResponse,
  Order,
  PaymentIntent,
  PlatformCompatibility,
  RecordServiceExecutionActionRequest,
  ReadyResponse,
  RefundRequest,
  GrantedServiceResult,
  ServiceCapabilityInvoked,
  ServiceExecutionAction,
  ServiceExecutionCheckoutCreated,
  ServiceExecutionEvents,
  ServiceExecutionReadModel,
  ServiceExecutionStarted,
  SSEEvent,
  StartServiceExecutionRequest,
} from "./types.js";

export class BackendClient {
  constructor(private readonly http: HttpClient) {}

  readyz(): Promise<ReadyResponse> {
    return this.http.get<ReadyResponse>("/v1/readyz");
  }

  compatibility(): Promise<PlatformCompatibility> {
    return this.http.get<PlatformCompatibility>("/v1/platform/compatibility");
  }

  // --- Catalog ---

  getCatalogManifest(): Promise<CatalogManifest> {
    return this.http.get<CatalogManifest>("/v1/catalog/manifest");
  }

  // --- Cart ---

  createCart(input: CreateCartRequest): Promise<Cart> {
    return this.http.post<Cart>("/v1/carts", input);
  }

  getCart(cartID: string): Promise<Cart> {
    return this.http.get<Cart>(`/v1/carts/${encodeURIComponent(cartID)}`);
  }

  addCartItem(cartID: string, input: AddCartItemRequest): Promise<Cart> {
    return this.http.post<Cart>(`/v1/carts/${encodeURIComponent(cartID)}/items`, input);
  }

  removeCartItem(cartID: string, cartItemID: string): Promise<Cart> {
    return this.http.delete<Cart>(
      `/v1/carts/${encodeURIComponent(cartID)}/items/${encodeURIComponent(cartItemID)}`,
    );
  }

  abandonCart(cartID: string): Promise<Cart> {
    return this.http.delete<Cart>(`/v1/carts/${encodeURIComponent(cartID)}`);
  }

  // --- Checkout ---

  createCheckout(input: CreateCheckoutRequest): Promise<CheckoutCreated> {
    return this.http.post<CheckoutCreated>("/v1/checkouts", input);
  }

  getCheckoutPresentation(checkoutID: string, displayToken: string): Promise<CheckoutPresentation> {
    const qs = new URLSearchParams({ display_token: displayToken });
    return this.http.get<CheckoutPresentation>(`/v1/checkouts/${encodeURIComponent(checkoutID)}/presentation?${qs}`);
  }

  // --- Payment intents ---

  createPaymentIntent(
    checkoutID: string,
    input: CreatePaymentIntentRequest,
    idempotencyKey?: string,
  ): Promise<PaymentIntent> {
    const options = idempotencyKey ? { idempotencyKey } : {};
    return this.http.post<PaymentIntent>(
      `/v1/checkouts/${encodeURIComponent(checkoutID)}/payment-intents`,
      input,
      options,
    );
  }

  // --- SSE streaming ---

  streamCheckoutEvents(
    checkoutID: string,
    displayToken: string,
    onEvent: (event: SSEEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const qs = new URLSearchParams({ display_token: displayToken });
    const url = `${this.http.baseURL}/v1/checkouts/${encodeURIComponent(checkoutID)}/events?${qs}`;
    return streamSSE(url, onEvent, signal);
  }

  // --- Orders ---

  getOrder(orderID: string): Promise<Order> {
    return this.http.get<Order>(`/v1/orders/${encodeURIComponent(orderID)}`);
  }

  listAccountOrders(limit: number, status?: string, bearer?: string): Promise<ListOrdersResponse> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (status) {
      qs.set("status", status);
    }
    return this.http.get<ListOrdersResponse>(`/v1/me/orders?${qs}`, bearer ? { bearer } : {});
  }

  // --- Refund ---

  createRefund(
    orderID: string,
    input: CreateRefundRequest,
    idempotencyKey?: string,
  ): Promise<RefundRequest> {
    const options = idempotencyKey ? { idempotencyKey } : {};
    return this.http.post<RefundRequest>(
      `/v1/orders/${encodeURIComponent(orderID)}/refunds`,
      input,
      options,
    );
  }

  // --- Service Execution ---

  startServiceExecution(input: StartServiceExecutionRequest): Promise<ServiceExecutionStarted> {
    return this.http.post<ServiceExecutionStarted>("/v1/service-executions", input);
  }

  invokeServiceCapability(
    serviceExecutionID: string,
    capabilityID: string,
    input: InvokeServiceCapabilityRequest,
  ): Promise<ServiceCapabilityInvoked> {
    return this.http.post<ServiceCapabilityInvoked>(
      `/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/capabilities/${encodeURIComponent(capabilityID)}/invoke`,
      input,
    );
  }

  recordServiceExecutionAction(
    serviceExecutionID: string,
    input: RecordServiceExecutionActionRequest,
  ): Promise<ServiceExecutionAction> {
    return this.http.post<ServiceExecutionAction>(
      `/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/actions`,
      input,
    );
  }

  createServiceExecutionCheckout(
    serviceExecutionID: string,
    input: CreateServiceExecutionCheckoutRequest,
  ): Promise<ServiceExecutionCheckoutCreated> {
    return this.http.post<ServiceExecutionCheckoutCreated>(
      `/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/checkout`,
      input,
    );
  }

  getServiceExecution(serviceExecutionID: string): Promise<ServiceExecutionReadModel> {
    return this.http.get<ServiceExecutionReadModel>(`/v1/service-executions/${encodeURIComponent(serviceExecutionID)}`);
  }

  listServiceExecutions(limit = 50): Promise<ListServiceExecutionsResponse> {
    return this.http.get<ListServiceExecutionsResponse>(`/v1/service-executions?limit=${limit}`);
  }

  listServiceExecutionEvents(serviceExecutionID: string): Promise<ServiceExecutionEvents> {
    return this.http.get<ServiceExecutionEvents>(`/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/events`);
  }

  getGrantedServiceResult(serviceExecutionID: string): Promise<GrantedServiceResult> {
    return this.http.get<GrantedServiceResult>(`/v1/service-executions/${encodeURIComponent(serviceExecutionID)}/granted-result`);
  }
}

// --- SSE streaming helper ---

async function streamSSE(
  url: string,
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let msg = `SSE stream failed: HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.message || parsed.code || msg;
    } catch {}
    throw new Error(msg);
  }
  if (!response.body) {
    throw new Error("SSE stream: no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent: Partial<SSEEvent> = {};
      for (const line of lines) {
        if (line === "") {
          if (currentEvent.type && currentEvent.payload) {
            onEvent(currentEvent as SSEEvent);
          }
          currentEvent = {};
          continue;
        }
        if (line.startsWith("event: ")) {
          currentEvent.type = line.slice(7);
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            currentEvent.type = currentEvent.type || data.event_type;
            currentEvent.aggregateType = data.aggregate_type;
            currentEvent.aggregateId = data.aggregate_id;
            currentEvent.sequence = data.sequence;
            currentEvent.payload = data;
          } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
