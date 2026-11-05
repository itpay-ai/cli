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
| `api tasks` | Local request→run/intent snapshots (may be stale); --refresh reads at most 20 original authoritative bindings, --request-id limits to one original request, --json. |
| `api resume <request_id>` | Continue the same recorded task; may POST its original intent. --wait then only reads its bound run; --json. Never use this as a status-only query or invent a new request. |
| `api run-status <run_id>` | Read original run once; --json. No --wait option; no new business call. |
| `api continue <intent_id>` | Continue only the original intent and current authority; --json. |
| `api wallet` / `api transactions` / `api usage` | Current account/consumer facts; --json. |
| `api topups` | Advertised fixed SKUs; --json. |
| `api topup <sku_id>` | Explicit user-requested cash top-up; --payer-currency, --for-intent, --channel, --mode, --json. SKU/channel must be advertised and permitted. |
| `api topup-status <topup_id>` | Original top-up fact; --json, not new top-up. |
| `api admin <action>` | Scoped administration only, current role/key required; --input - or private @file; --json. Not normal consumer discovery. |

Group options `--host`/`--target` describe real trusted payment presentation, not permission escalation. Shared global flags come from root help, not Services-specific JSON.

## Safe continuation

Inspect all conditions/effects and publication before running. Ordinary API budget does not approve a purchase or external write. `--max-charge` is scale6 atoms, not yuan/fen. Read the returned complete envelope directly, not through an ad hoc parser. An accepted/unknown request must keep its original ID and input; use tasks/resume/status, not repeat run under a new key. Use terminal/pending_stage/next.read_only rather than an outer result object or execution status alone. Honor bounded waits and current recovery conditions; unknown lookup is not a recharge instruction. An intent resume requires confirmed normal authorization and permission to continue; tasks --refresh and run-status only read. Explicitly export ITPAY_STATE_DIR and privately verify the actual profile/consumer before an authorized isolated run; merely using a shell variable for log filenames does not configure the CLI.

The current local candidate includes this reference and the independent API Skill. Read it with `itpay skill show itpay-api --json`; its full original is in result.content. This read never connects, registers a Services device or writes identity. The API Skill ignores ITPAY_CLI_SKILLS_DIR (a Services-only override); missing or mismatched package content fails without falling back to Services. This is local candidate verification, not an npm channel update or natural Agent acceptance.

## Entry selection

For a new task, prefer the official pinned ItPay CLI when execution is permitted and available in the current host. Install only through the host-permitted official installation path when authorized. Services tasks use the Services Skill; API tasks use the independent API Skill and `itpay api`. CLI calls HTTP APIs directly, never MCP transport. Without permitted CLI capability, use the corresponding ItPay-hosted user Services MCP or Hub MCP and only its actually available tools; ordinary users do not self-host another MCP. Platform-required workflows and explicit connection tests follow the actual available capability. Entry selection never authorizes a permission bypass: preserve the original identity, entry, request/run and current grant after acceptance or an unknown result. Continue across entries only when the owner explicitly supports recovery under the same actual authority; CLI errors never license a substitute transaction or raw HTTP workaround.
