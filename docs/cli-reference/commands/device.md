# `itpay device`

`itpay` is the single public CLI entry point; `$itpay` is its user-facing Skill invocation.

## Stable identity and ordinary recovery

The original Ed25519 key stays at its existing location. Old `identity.json` v1/v2 is read-only compatibility data. Normal authorization does not acquire legacy locks, inspect processes, or create transition tickets/archives. Old lock files remain untouched.

Each official Backend, actual Agent Type and current key fingerprint has its own atomic session cache. On a rejected session the CLI invalidates only that context, renews it, and retries the original request once. A second failure stops. Corrupt identity, missing original key, permission denial or unknown results never cause automatic key replacement. Do not delete identity, switch runtime/type or disable host protection.

## `itpay device recover`

Only after an operator confirms the selected Backend registration database was reset:

```sh
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
```

This invalidates the selected Backend's caches, preserves the key, old identity and other Backend contexts, and returns a same-Backend/type `auth status` command. It does not contact the Backend itself or authorize business. Missing type or confirmation fails before mutation. Do not use it for expiry, revocation, quota or an unconfirmed failure.

Success status is `backend_cache_invalidated` or `backend_cache_absent`; `result.invalidated_agent_types` records the affected types. The next device check proves the original key to the selected Backend and reuses its authoritative Device/key/quota lineage. No token or private key appears in output.

## `itpay device repair-lock`

```sh
itpay device repair-lock --json
```

Compatibility explanation only: status `device_legacy_lock_unmanaged`, lock_status `unmanaged`, identity preserved. No legacy file is read, moved or deleted. This does not claim a lock was repaired. Ordinary authorization needs no lock cleanup.

## `itpay device reset-key`

This version does not support automatic device key reset. The command name and existing type/confirmation guards remain recognized:

```sh
itpay --agent-type <agent_type> device reset-key --confirm-key-reset --json
```

It returns nonzero `device_key_reset_unavailable`, next=null, recovery=[]; the original identity is unchanged. Do not delete a key manually, install an older version to reset it, or present this command as a recovery action. Restoring safe explicit key replacement requires a separately reviewed implementation.
