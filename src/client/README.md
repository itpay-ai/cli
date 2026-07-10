# CLI Client

Thin HTTP/JSON client for the V3 backend. One module per concern.

## Files

- `types.ts` — V3 request/response DTOs. Keep in sync with `services/backend/internal/presenter/*.go`.
- `http.ts` — generic `HttpClient` (fetch wrapper, JSON encode/decode, `Idempotency-Key` and `Authorization` headers, error mapping).
- `backend.ts` — typed `BackendClient` exposing one method per route family (`readyz`, carts, checkouts, payment-intents, orders, refunds).

## Rules

- Do not duplicate DTOs in `commands/` or `render/`.
- Do not introduce retries or SDK abstractions here. Higher layers own semantics.
- Do not import from `state/` — keep `client/` side-effect free for tests.
- New endpoints belong here as new methods on `BackendClient`, not as ad-hoc fetches in `main.ts`.
