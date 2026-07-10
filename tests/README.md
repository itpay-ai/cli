# CLI Tests

Smoke tests for the V3 CLI. They do not require a live backend — they
boot a tiny `node:http` mock that mirrors the V3 DTO contracts, then
exercise each command and the end-to-end happy path.

## Files

- `mock_backend.ts` — minimal V3 mock server. Implements `readyz`,
  carts, checkouts, payment-intents, orders, me/orders, refunds.
  Records every request for assertions.
- `smoke.test.ts` — `node:test` cases. One test per command plus a
  full `buy -> checkout -> pay -> order -> orders -> refund` walk.

## Run

```bash
pnpm --filter @itpay/cli test
```

## What the tests assert

- HTTP method, path, query string, and request body shape
- `Authorization: Bearer <token>` and `Idempotency-Key` headers
- DTO field names (snake_case) on the wire
- CLI error contract (`HttpError` carries the backend `code` field)

## Rules

- Tests must not require a real backend, network, or secrets.
- Tests must not write to stdout — all commands are called with a
  silent `OutputSink` so the test runner stays readable.
- New endpoints go into `mock_backend.ts` first, then into the
  `BackendClient`, then into the smoke test.
