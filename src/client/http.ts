// Thin HTTP client for V3 backend. Keep this file boring on purpose:
// no retries, no SDK abstractions, no business logic. Higher layers
// own semantics (e.g. CLI commands, frontend feature hooks).

import type { ErrorResponse } from "./types.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  bearer?: string;
  idempotencyKey?: string;
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
}

export class HttpClient {
  readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestAuthorizer?: HttpClientConfig["requestAuthorizer"];
  private readonly recoverAuthorization?: HttpClientConfig["recoverAuthorization"];

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
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith("http") ? path : this.baseURL + path;
	const method = options.method ?? "GET";
	const body = options.body !== undefined ? JSON.stringify(options.body) : "";
    const requestPath = new URL(url).pathname + new URL(url).search;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers: Record<string, string> = { ...this.defaultHeaders };
      if (this.requestAuthorizer) {
        Object.assign(headers, await this.requestAuthorizer({ method, path: requestPath, body }));
      }
      if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

      const response = await this.fetchImpl(url, {
	    method,
        headers,
	    ...(options.body !== undefined ? { body } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const text = await response.text();
      const parsed = text.length > 0 ? safeParseJson(text) : undefined;
      if (response.ok) return parsed as T;

      const error = new HttpError(response.status, parsed as ErrorResponse | undefined, `HTTP ${response.status}`);
      if (attempt === 0 && error.status === 401 && error.code === "agent_device_session_required" && this.recoverAuthorization) {
        await this.recoverAuthorization();
        continue;
      }
      throw error;
    }
    throw new Error("unreachable HTTP retry state");
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
