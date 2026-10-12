// Thin HTTP client for V3 backend. Keep retry policy transport-only: bounded
// retries are allowed only for reads or explicitly replay-safe writes.
// HTTP/business failures remain owned by higher-level commands.

import type { ErrorResponse } from "./types.js";
import { asTransientTransportError, HttpTransportError, type RequestDiagnostic } from "./transport.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  bearer?: string;
  idempotencyKey?: string;
  replaySafe?: boolean;
  signal?: AbortSignal;
  deadline?: number;
}

export class HttpError extends Error {
  diagnostics: RequestDiagnostic[] = [];
  readonly status: number;
  readonly code: string;
  readonly payload: ErrorResponse | undefined;

  constructor(status: number, payload: ErrorResponse | undefined, fallbackMessage: string) {
    super(payload?.message || fallbackMessage);
    this.status = status;
    this.code = payload?.code || "unknown_error";
    this.payload = payload;
  }
}

export interface HttpClientConfig {
  baseURL: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  requestAuthorizer?: (input: { method: string; path: string; body: string }) => Promise<Record<string, string>>;
  recoverAuthorization?: () => Promise<void>;
  transportRetryDelayMs?: number;
  onDiagnostic?: (diagnostic: RequestDiagnostic) => void;
}

export class HttpClient {
  localSimulation = false;
  private static readonly MAX_TRANSPORT_RETRIES = 2;
  readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestAuthorizer?: HttpClientConfig["requestAuthorizer"];
  private readonly recoverAuthorization?: HttpClientConfig["recoverAuthorization"];
  private readonly transportRetryDelayMs: number;
  private readonly onDiagnostic?: HttpClientConfig["onDiagnostic"];

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.defaultHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(config.defaultHeaders ?? {}),
    };
    this.requestAuthorizer = config.requestAuthorizer;
    this.recoverAuthorization = config.recoverAuthorization;
    this.onDiagnostic = config.onDiagnostic;
    this.transportRetryDelayMs = Math.max(0, config.transportRetryDelayMs ?? 200);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, {once:true});
    if (options.signal?.aborted) abort();
    const remaining = (options.deadline ?? Date.now()+30000)-Date.now();
    const timeoutReason = new DOMException("request deadline reached", "TimeoutError");
    if (remaining <= 0) controller.abort(timeoutReason);
    const timer = remaining > 0 ? setTimeout(() => controller.abort(timeoutReason),remaining) : undefined;
    const requestStarted = Date.now();
    const diagnostics: RequestDiagnostic[] = [];
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_,reject) => {
      abortListener = () => reject(controller.signal.reason);
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener("abort",abortListener,{once:true});
    });
    try {
      return await Promise.race([this.performRequest<T>(path,{...options,signal:controller.signal},diagnostics),cancelled]);
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        const timeout = new HttpTransportError("network_timeout",Math.max(1,diagnostics.length),"DEADLINE_EXCEEDED",error);
        if (diagnostics.length === 0) diagnostics.push({method:options.method ?? "GET",route_template:safeRouteTemplate(new URL(path,this.baseURL).pathname),attempt:1,attempt_ms:Math.max(0,remaining),total_ms:Math.max(0,remaining),phase:"unknown",cause_code:"DEADLINE_EXCEEDED"});
        const last=diagnostics.at(-1);
        if(last) last.total_ms=Date.now()-requestStarted;
        timeout.diagnostics=diagnostics;
        throw timeout;
      }
      if (error instanceof HttpError || error instanceof HttpTransportError) error.diagnostics=diagnostics;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort",abort);
      if (abortListener) controller.signal.removeEventListener("abort",abortListener);
    }
  }

  private async performRequest<T>(path: string, options: RequestOptions, diagnostics: RequestDiagnostic[]): Promise<T> {
    const url = path.startsWith("http") ? path : this.baseURL + path;
    const method = options.method ?? "GET";
    const body = options.body !== undefined ? JSON.stringify(options.body) : "";
    const requestPath = new URL(url).pathname + new URL(url).search;
    const replaySafe = method === "GET" || Boolean(options.idempotencyKey) || options.replaySafe === true;
    const started = Date.now();
    let authorizationRecovered = false;
    let transportRetries = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const attemptStarted = Date.now();
      const attempt = diagnostics.length + 1;
      let phase: RequestDiagnostic["phase"] = "unknown";
      let requestID: string | undefined;
      const diagnostic: RequestDiagnostic = {method,route_template:safeRouteTemplate(new URL(url).pathname),attempt,attempt_ms:0,total_ms:Date.now()-started,phase};
      diagnostics.push(diagnostic);
      const abortAttempt=()=>record("DEADLINE_OR_ABORT");
      const record = (causeCode?: string) => {
        options.signal?.removeEventListener("abort",abortAttempt);
        Object.assign(diagnostic,{attempt_ms:Date.now()-attemptStarted,total_ms:Date.now()-started,phase,...(requestID?{request_id:requestID}:{}),...(causeCode?{cause_code:causeCode}: {})});
        this.onDiagnostic?.(diagnostic);
      };
      options.signal?.addEventListener("abort",abortAttempt,{once:true});
      const headers: Record<string, string> = { ...this.defaultHeaders };
      try {
        if (this.requestAuthorizer) {
          Object.assign(headers, await this.requestAuthorizer({ method, path: requestPath, body }));
        }
      } catch (error) {
        // Authorization can perform enrollment or session POSTs before the
        // protected request exists. Classify their transport failure, but do
        // not inherit the outer request's replay policy for those writes.
        record(error instanceof HttpTransportError ? error.causeCode : "AUTHORIZATION_FAILED");
        if (error instanceof HttpTransportError) throw error;
        throw asTransientTransportError(error, 1) ?? error;
      }
      options.signal?.throwIfAborted();
      if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

      let response: Response;
      let text: string;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        phase = "response_body";
        diagnostic.phase=phase;
        const headerID = response.headers.get("X-ItPay-Request-ID");
        if (headerID && /^req_[a-f0-9]{1,64}$/.test(headerID)) {requestID = headerID;diagnostic.request_id=headerID;}
        text = await response.text();
        this.localSimulation = response.headers.get("X-ItPay-Environment") === "local_simulation";
      } catch (error) {
        if (options.signal?.aborted) {record("DEADLINE_OR_ABORT");throw error;}
        const transportError = asTransientTransportError(error, transportRetries + 1);
        record(transportError?.causeCode ?? "UNKNOWN_TRANSPORT_FAILURE");
        if (!transportError) throw error;
        if (replaySafe && transportRetries < HttpClient.MAX_TRANSPORT_RETRIES) {
          transportRetries += 1;
          await delay(this.transportRetryDelayMs * (2 ** (transportRetries - 1)), options.signal);
          continue;
        }
        throw asTransientTransportError(error, transportRetries + 1) ?? error;
      }
      record(response.ok ? undefined : `HTTP_${response.status}`);
      const parsed = text.length > 0 ? safeParseJson(text) : undefined;
      if (response.ok) return parsed as T;

      const error = new HttpError(response.status, parsed as ErrorResponse | undefined, `HTTP ${response.status}`);
      if (!authorizationRecovered && error.status === 401 && error.code === "agent_device_session_required" && this.recoverAuthorization) {
        authorizationRecovered = true;
        options.signal?.throwIfAborted();
        await this.recoverAuthorization();
        options.signal?.throwIfAborted();
        continue;
      }
      throw error;
    }
  }

  get<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T>(path: string, body: unknown, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},milliseconds);
    signal?.addEventListener("abort",abort,{once:true});
  });
}

// Only static route words are retained; IDs and unknown segments are masked.
function safeRouteTemplate(path: string): string {
  const staticSegments = new Set(["v1","v3","readyz","service-executions","service-definitions","services","advance","actions","checkout","checkouts","presentation","capabilities","invoke","result-items","events","orders","refunds","cancel","cart","carts","items","quotes","quote","agent-device-enrollments","agent-device-sessions","verify","auth-sessions"]);
  return path.split("/").map(segment=>staticSegments.has(segment)?segment:segment?"{value}":"").join("/");
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
