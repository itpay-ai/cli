import { runWithTransportRetry, type TransportObserver } from "../client/transport.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ImageFetchOptions {
  fetchImpl?: typeof fetch;
  transportRetryDelayMs?: number;
  transportObserver?: TransportObserver;
  transportDiagnosticLog?: string;
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}

export async function fetchImage(url: string, options: ImageFetchOptions = {}): Promise<FetchedImage> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const result = await runWithTransportRetry<FetchedImage>({
    method: "GET",
    url,
    replaySafe: true,
    maxRetries: 2,
    retryDelayMs: options.transportRetryDelayMs ?? 200,
    ...(options.transportDiagnosticLog ? { diagnosticLog: options.transportDiagnosticLog } : {}),
    ...(options.transportObserver ? { observer: options.transportObserver } : {}),
  }, async (attempt, requestID) => {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "image/png,image/jpeg,image/webp,image/svg+xml",
        "X-ItPay-Request-ID": requestID,
        "X-ItPay-Request-Attempt": String(attempt),
      },
    });
    if (!response.ok) throw new Error(`image request returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error("image response exceeds size limit");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) throw new Error("image response was empty");
    if (body.length > MAX_IMAGE_BYTES) throw new Error("image response exceeds size limit");
    return { body, contentType: (response.headers.get("content-type") ?? "").toLowerCase() };
  });
  return result.value;
}
