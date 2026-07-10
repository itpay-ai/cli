# CLI State

Local CLI configuration. The CLI never stores provider secrets. It stores the
last checkout-scoped display token only in the local cart session file so a
restarted agent can resume the same checkout.

## Files

- `config.ts` — `loadConfig()` reads `ITPAY_*` environment variables and
  builds a `BackendClient`. Used by every command in `main.ts`.

## Rules

- Store only the minimum local material: backend URL, optional bearer
  token, agent device id, default currency, idempotency key.
- Persist checkout-scoped `display_token` only in the cart session file, with
  owner-only file permissions (`0600`), for checkout recovery.
- Persist Service checkout handoffs atomically before QR rendering. Recover a
  lost or expired handoff with `services checkout <execution_id> --resume
  --json`; the server reuses the existing checkout owner facts.
- Never store provider app keys, private keys, or any raw provider payload.
