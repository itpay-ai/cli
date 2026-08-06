// Thin HTTP client for V3 backend. Keep retry policy transport-only: bounded
// retries are allowed only for reads or explicitly replay-safe writes.
// HTTP/business failures remain owned by higher-level commands.

import type { ErrorResponse } from "./types.js";
import { asTransientTransportError, HttpTransportError, runWithTransportRetry, type TransportObserver } from "./transport.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  bearer?: string;
  idempotencyKey?: string;
  replaySafe?: boolean;
  signal?: AbortSignal;
}

export class HttpError extends Error {
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
  transportObserver?: TransportObserver;
  transportDiagnosticLog?: string;
}

export class HttpClient {
  private static readonly MAX_TRANSPORT_RETRIES = 2;
  readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestAuthorizer?: HttpClientConfig["requestAuthorizer"];
  private readonly recoverAuthorization?: HttpClientConfig["recoverAuthorization"];
  private readonly transportRetryDelayMs: number;
  private readonly transportObserver: TransportObserver | undefined;
  private readonly transportDiagnosticLog: string | undefined;

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
    this.transportRetryDelayMs = Math.max(0, config.transportRetryDelayMs ?? 200);
    this.transportObserver = config.transportObserver;
    this.transportDiagnosticLog = config.transportDiagnosticLog;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith("http") ? path : this.baseURL + path;
    const method = options.method ?? "GET";
    const body = options.body !== undefined ? JSON.stringify(options.body) : "";
    const requestPath = new URL(url).pathname + new URL(url).search;
    const replaySafe = method === "GET" || Boolean(options.idempotencyKey) || options.replaySafe === true;
    let authorizationRecovered = false;
    for (;;) {
      const transport = await runWithTransportRetry<{ response: Response; text: string }>({
        method, url, replaySafe,
        ...(options.signal ? { signal: options.signal } : {}),
        maxRetries: HttpClient.MAX_TRANSPORT_RETRIES,
        retryDelayMs: this.transportRetryDelayMs,
        ...(this.transportDiagnosticLog ? { diagnosticLog: this.transportDiagnosticLog } : {}),
        ...(this.transportObserver ? { observer: this.transportObserver } : {}),
      }, async (attempt, requestID) => {
        const headers: Record<string, string> = {
          ...this.defaultHeaders,
          "X-ItPay-Request-ID": requestID,
          "X-ItPay-Request-Attempt": String(attempt),
        };
        try {
          if (this.requestAuthorizer) {
            Object.assign(headers, await this.requestAuthorizer({ method, path: requestPath, body }));
          }
        } catch (error) {
          if (error instanceof HttpTransportError) throw error;
          throw asTransientTransportError(error, 1, requestID, this.transportDiagnosticLog) ?? error;
        }
        if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
        if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
        const response = await this.fetchImpl(url, {
          method, headers,
          ...(options.body !== undefined ? { body } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return { response, text: await response.text() };
      });
      const { response, text } = transport.value;
      const parsed = text.length > 0 ? safeParseJson(text) : undefined;
      if (response.ok) return parsed as T;

      const error = new HttpError(response.status, parsed as ErrorResponse | undefined, `HTTP ${response.status}`);
      if (!authorizationRecovered && error.status === 401 && error.code === "agent_device_session_required" && this.recoverAuthorization) {
        authorizationRecovered = true;
        await this.recoverAuthorization();
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

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
