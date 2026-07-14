# CLI State

Local CLI configuration and owner-only recovery state. The CLI never stores
provider secrets. It stores one local Device signing key, Backend-scoped
registrations and sessions, idempotency handles, and the last checkout-scoped
display token needed to resume the same checkout.

## Files

- `config.ts` — `loadConfig()` reads `ITPAY_*` environment variables and
  builds a `BackendClient`. Used by every command in `main.ts`.
- `agent_type.ts` — reads the explicitly declared runtime type and preserves it
  in generated ItPay commands.
- `device_authority.ts` — keeps one local Ed25519 key and one registration per
  normalized Backend URL, with one Agent Instance per Agent Type.

## Rules

- Keep the private key and Device state owner-only (`0600`); never expose them
  in command output or copy server IDs between Backend registrations.
- Reuse one Agent Instance for all windows and chats of the same Agent Type.
- Serialize Device state changes with an atomic owner-only directory lock and
  atomic file replacement. Return `device_state_unwritable` when the Host
  cannot persist this state; never advise switching runtimes or identities.
- Renew a rejected session and retry the same request exactly once. Never
  replace a revoked v2 Device automatically.
- Persist checkout-scoped `display_token` only in the cart session file, with
  owner-only file permissions (`0600`), for checkout recovery.
- Persist Service checkout handoffs atomically before QR rendering. Recover a
  lost or expired handoff with `services checkout <execution_id> --resume
  --json`; the server reuses the existing checkout owner facts.
- Never store provider app keys, private keys, or any raw provider payload.
