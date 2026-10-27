# `itpay api` command reference

This is the API-only entry; Services documentation is not required. `itpay hub` is the same registration's compatibility alias. Use `itpay api --help` or the specific subcommand's `--help` for exact flags. Angle-bracket values below are templates, never executable returned actions.

## Connection and scope

Set the actual ITPAY_HUB_URL for the approved environment and preserve actual Agent Type, launcher and ITPAY_STATE_DIR across commands. Default source configuration is loopback when no URL is supplied; do not assume it points at production. `api connect` uses browser OAuth/PKCE. `api credentials import` reads an authorized ItPay key from stdin; never put a key/token in argv/chat or borrow Services credentials. `api doctor` is a read-only diagnostic, not a routine prerequisite. Credentials are endpoint-scoped; changing the account/resource is not a recovery technique.

## Registered commands

| Command | Use / important flags |
|---|---|
| `api discover` | Published catalog; --query, --kinds, --effect-classes, --limit, --json. Never guess operation IDs. |
| `api inspect <operation_id>` | Current publication, effects, schema and pricing; --json. |
| `api run <operation_id>` | --publication and --input required; input JSON/@file/-; --credential-id, --source-credentials, --max-charge, --request-id, --wait, --json as needed. IDs/credential references come from real records, not examples. |
| `api tasks` | Durable local request→run/intent references; --json. |
| `api resume <request_id>` | Resume same recorded task; --wait, --json; never invent a new request ID to recover unknown. |
| `api run-status <run_id>` | Read original run; --json; does not create another call. |
| `api continue <intent_id>` | Continue only the original intent and current authority; --json. |
| `api wallet` / `api transactions` / `api usage` | Current account/consumer facts; --json. |
| `api topups` | Advertised fixed SKUs; --json. |
| `api topup <sku_id>` | Explicit user-requested cash top-up; --payer-currency, --for-intent, --channel, --mode, --json. SKU/channel must be advertised and permitted. |
| `api topup-status <topup_id>` | Original top-up fact; --json, not new top-up. |
| `api admin <action>` | Scoped administration only, current role/key required; --input - or private @file; --json. Not normal consumer discovery. |

Group options `--host`/`--target` describe real trusted payment presentation, not permission escalation. Shared global flags come from root help, not Services-specific JSON.

## Safe continuation

Inspect all conditions/effects and publication before running. Ordinary API budget does not approve a purchase or external write. `--max-charge` is scale6 atoms, not yuan/fen. Read the returned complete envelope directly, not through an ad hoc parser. An accepted/unknown request must keep its original ID and input; use tasks/resume/status, not repeat run under a new key. Honor bounded waits and current recovery conditions.

The current local candidate includes this reference and the independent API Skill. Read it with `itpay skill show itpay-api --json`; its full original is in result.content. This read never connects, registers a Services device or writes identity. The API Skill ignores ITPAY_CLI_SKILLS_DIR (a Services-only override); missing or mismatched package content fails without falling back to Services. This is local candidate verification, not an npm channel update or natural Agent acceptance.
