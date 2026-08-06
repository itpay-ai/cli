# CLI Client

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

Thin HTTP/JSON client for the V3 backend. One module per concern.

## Files

- `types.ts` — V3 request/response DTOs. Keep in sync with `services/backend/internal/presenter/*.go`.
- `http.ts` — generic `HttpClient` (fetch wrapper, JSON encode/decode, `Idempotency-Key` and `Authorization` headers, bounded replay policy, error mapping).
- `transport.ts` — safe transport-error classification. Two bounded retries with short increasing backoff are limited to reads, idempotency-keyed writes, and operations whose Backend contract is explicitly transactionally replay-safe.
- `backend.ts` — typed `BackendClient` exposing one method per route family (`readyz`, carts, checkouts, payment-intents, orders, refunds).

## Rules

- Do not duplicate DTOs in `commands/` or `render/`.
- Transport retries stay in `http.ts`; higher layers may only declare an operation replay-safe when the Backend contract guarantees it. Do not add command-local retries or SDK abstractions.
- Do not import from `state/` — keep `client/` side-effect free for tests.
- New endpoints belong here as new methods on `BackendClient`, not as ad-hoc fetches in `main.ts`.
