# CLI Render

Terminal-only output helpers.

## Files

- `output.ts` — format money, render checkout QR, render order/refund/presentation blocks.
- `status.ts` — checkout/order/refund status enum → human hint lookup.

## Rules

- Render code must not issue HTTP calls.
- Render code must not import from `client/` or `state/`.
- All money formatting should go through `formatMoney` so we have a single
  source of truth for minor-unit display.
