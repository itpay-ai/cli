# CLI Commands

Each command is a small orchestration file: parse input, call one or more
typed backend methods, render the result. No HTTP, no business truth.

## Files

- `readyz.ts` — `GET /v1/readyz`
- `buy.ts` — `POST /v1/carts` + `POST /v1/checkouts`, then print checkout QR (NOT a provider QR)
- `checkout.ts` — `GET /v1/checkouts/{id}/presentation?display_token=...`
- `pay.ts` — `POST /v1/checkouts/{id}/payment-intents` (CLI escape hatch only)
- `order.ts` — `GET /v1/orders/{id}`
- `orders.ts` — `GET /v1/me/orders` (account-scoped bearer required)
- `refund.ts` — `POST /v1/orders/{id}/refunds`

## Rules

- One command per file. Keep each one short (< ~100 lines).
- The default `buy` path creates cart + checkout only; `buy --pay` is the explicit payment-intent path.
- Checkout-scoped `display_token` may be persisted only through the local cart session recovery file.
- Instructions must be executable. Recover Service checkout handoffs with
  `services checkout <execution_id> --resume --json`; never emit an unresolved
  `<display_token>` placeholder.
- A command must not infer state — re-read canonical status from the API.
