# CLI Tests

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

Smoke tests for the V3 CLI. They do not require a live backend — they
boot a tiny `node:http` mock that mirrors the V3 DTO contracts, then
exercise each command and the end-to-end happy path.

Production configuration remains pinned to `https://app.itpay.ai` with no Backend override path. CLI process tests load `tests/cli_test_entry.ts`, which verifies that the CLI requested `app.itpay.ai` and reroutes only the test transport to an HTTP loopback mock; production source configuration is never changed.

## Files

- `mock_backend.ts` — minimal V3 mock server. Implements `readyz`,
  carts, checkouts, payment-intents, orders, me/orders, refunds.
  Records every request for assertions.
- `smoke.test.ts` — `node:test` cases. One test per command plus a
  full `buy -> checkout -> pay -> order -> orders -> refund` walk.
- `render_utilities.test.ts` — branch coverage for terminal summaries,
  status hints, plain-chat interactions, and inline terminal images.
- `cli_test_entry.ts` — test-only `fetch` transport shim that accepts only
  `app.itpay.ai` source requests and an HTTP loopback mock destination.
- `scripts/package-smoke.mjs` — validates every public command path with
  `--help` against the packed artifact, then checks representative offline commands.

## Run

```bash
npm test
npm run test:coverage
npm run test:package
```

## What the tests assert

- HTTP method, path, query string, and request body shape
- `Authorization: Bearer <token>` and `Idempotency-Key` headers
- DTO field names (snake_case) on the wire
- CLI error contract (`HttpError` carries the backend `code` field)
- Production Backend pinning and test-only loopback isolation
- Minimum source coverage: 85% statements/lines, 90% functions, 70% branches
- Every public packaged CLI command path parses and exits successfully with `--help`

## Rules

- Tests must not require a real backend, network, or secrets.
- Tests must not write to stdout — all commands are called with a
  silent `OutputSink` so the test runner stays readable.
- New endpoints go into `mock_backend.ts` first, then into the
  `BackendClient`, then into the smoke test.
