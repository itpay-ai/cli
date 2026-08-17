# CLI State

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

Local CLI configuration and owner-only recovery state. The CLI never stores
provider secrets. It stores one local Device signing key, Backend-scoped
official registrations and sessions, idempotency handles, and the last checkout-scoped
display token needed to resume the same checkout. Production and dev recovery
handles use separate files.

## Files

- `config.ts` — `loadConfig()` defaults to `https://app.itpay.ai`, accepts only
  the exact official dev override, selects Backend-scoped recovery files, and
  builds a `BackendClient`. Used by every command in `main.ts`.
- `agent_type.ts` — reads the explicitly declared runtime type and preserves it
  in generated ItPay commands.
- `device_authority.ts` — keeps one local Ed25519 key and one registration per
  official Backend, with one Agent Instance per Agent Type.
- `operation_journal.ts` — preserves idempotency with one immutable owner-only
  record per operation key. Legacy `operations.json` is read only; operations
  never wait on one global lock.

## Rules

- Keep the private key and Device state owner-only (`0600`); never expose them
  in command output or use a Backend other than official app.itpay.ai/dev.itpay.ai.
- Reuse one Agent Instance for all windows and chats of the same Agent Type.
- Serialize Device state changes with an atomic owner-token file lock and
  atomic file replacement. Release and stale recovery rename the canonical
  lock instead of deleting it, so sandbox safe-delete/trash shims cannot turn
  a successful authorization into a failure. Only the current owner may
  release the lock. Return `device_state_unwritable` when the Host cannot
  persist this state; never advise switching runtimes or identities.
- Multiple local Agent Types share the same Device key but keep distinct Agent
  Instances. A local lock wait is never a Backend Buyer lock and never crosses
  computers.
- Renew a rejected session and retry the same request exactly once. Never
  replace a revoked v2 Device automatically.
- Persist checkout-scoped `display_token` only in the cart session file, with
  owner-only file permissions (`0600`), for checkout recovery.
- Persist each idempotency handle under `operations.json.d/` (or the dev
  equivalent) with owner-only permissions. Publish each record atomically,
  preserve legacy IDs, and fail closed on a malformed authority record.
- Persist Service checkout handoffs atomically before QR rendering. Recover a
  lost or expired handoff with `services checkout <execution_id> --resume
  --json`; the server reuses the existing checkout owner facts.
- Never store provider app keys, private keys, or any raw provider payload.
