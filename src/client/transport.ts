import { randomUUID } from "node:crypto";

export type TransportErrorCode =
  | "network_connection_reset"
  | "network_timeout"
  | "network_dns_temporary"
  | "network_unreachable"
  | "network_connection_refused"
  | "network_socket_error"
  | "network_transport_failed";

export class HttpTransportError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: TransportErrorCode,
    readonly attempts: number,
    readonly causeCode: string | undefined,
    readonly requestID: string,
    readonly diagnosticLog: string | undefined,
    cause: unknown,
  ) {
    const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
    super(`${transportMessage(code)} before a complete HTTP response was received${suffix}`, { cause });
    this.name = "HttpTransportError";
  }
}

export interface TransportDiagnosticEvent {
  timestamp: string;
  request_id: string;
  method: string;
  origin: string;
  path: string;
  attempt: number;
  outcome: "retrying" | "recovered" | "failed";
  elapsed_ms: number;
  code?: TransportErrorCode;
  cause_code?: string;
}

export type TransportObserver = (event: TransportDiagnosticEvent) => void;

export interface TransportRetryOptions {
  method: string;
  url: string;
  replaySafe: boolean;
  signal?: AbortSignal;
  maxRetries?: number;
  retryDelayMs?: number;
  requestID?: string;
  diagnosticLog?: string;
  observer?: TransportObserver;
}

export interface TransportRunResult<T> {
  value: T;
  requestID: string;
  attempts: number;
}

export async function runWithTransportRetry<T>(
  options: TransportRetryOptions,
  run: (attempt: number, requestID: string) => Promise<T>,
): Promise<TransportRunResult<T>> {
  const requestID = options.requestID ?? newTransportRequestID();
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
  const startedAt = Date.now();
  let failures = 0;
  for (;;) {
    const attempt = failures + 1;
    try {
      const value = await run(attempt, requestID);
      if (failures > 0) {
        observe(options, {
          timestamp: new Date().toISOString(), request_id: requestID,
          method: options.method, ...safeURLParts(options.url), attempt,
          outcome: "recovered", elapsed_ms: Date.now() - startedAt,
        });
      }
      return { value, requestID, attempts: attempt };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // A nested request (for example Device enrollment/session recovery)
      // already made its own replay decision. Never inherit the outer
      // operation's replay policy.
      if (error instanceof HttpTransportError) throw error;
      const transportError = asTransientTransportError(error, attempt, requestID, options.diagnosticLog);
      if (!transportError) throw error;
      const willRetry = options.replaySafe && failures < maxRetries;
      observe(options, {
        timestamp: new Date().toISOString(), request_id: requestID,
        method: options.method, ...safeURLParts(options.url), attempt,
        outcome: willRetry ? "retrying" : "failed",
        elapsed_ms: Date.now() - startedAt,
        code: transportError.code,
        ...(transportError.causeCode ? { cause_code: transportError.causeCode } : {}),
      });
      if (!willRetry) throw transportError;
      failures += 1;
      await delay(retryDelayMs * (2 ** (failures - 1)));
    }
  }
}

export function asTransientTransportError(
  error: unknown,
  attempts: number,
  requestID = newTransportRequestID(),
  diagnosticLog?: string,
): HttpTransportError | undefined {
  if (isAbort(error)) return undefined;
  const causeCode = findCauseCode(error);
  const code = causeCode ? classifyCauseCode(causeCode) : classifyFetchFailure(error);
  return code ? new HttpTransportError(code, attempts, causeCode, requestID, diagnosticLog, error) : undefined;
}

export function newTransportRequestID(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function classifyCauseCode(code: string | undefined): TransportErrorCode | undefined {
  switch (code) {
    case "ECONNRESET":
      return "network_connection_reset";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return "network_timeout";
    case "EAI_AGAIN":
      return "network_dns_temporary";
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return "network_unreachable";
    case "ECONNREFUSED":
      return "network_connection_refused";
    case "UND_ERR_SOCKET":
      return "network_socket_error";
    default:
      return undefined;
  }
}

function classifyFetchFailure(error: unknown): TransportErrorCode | undefined {
  return error instanceof TypeError && error.message === "fetch failed"
    ? "network_transport_failed"
    : undefined;
}

function findCauseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function safeURLParts(value: string): { origin: string; path: string } {
  try {
    const url = new URL(value);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: "invalid", path: "/" };
  }
}

function observe(options: TransportRetryOptions, event: TransportDiagnosticEvent): void {
  try {
    options.observer?.(event);
  } catch {
    // Diagnostics must never change command behavior.
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transportMessage(code: TransportErrorCode): string {
  switch (code) {
    case "network_connection_reset":
      return "network connection was reset";
    case "network_timeout":
      return "network connection timed out";
    case "network_dns_temporary":
      return "DNS lookup was temporarily unavailable";
    case "network_unreachable":
      return "network was unreachable";
    case "network_connection_refused":
      return "network connection was refused";
    case "network_socket_error":
      return "network socket failed";
    case "network_transport_failed":
      return "network transport failed";
  }
}
