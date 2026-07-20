# CLI Render

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

Terminal-only output helpers.

## Files

- `output.ts` — format money, render checkout QR, render order/refund/presentation blocks.
- `status.ts` — checkout/order/refund status enum → human hint lookup.

## Rules

- Render code must not issue HTTP calls.
- Render code must not import from `client/` or `state/`.
- All money formatting should go through `formatMoney` so we have a single
  source of truth for minor-unit display.
