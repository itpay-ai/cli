# ItPay CLI

The official V3 CLI for Agent-driven ItPay service discovery, checkout, delivery, order recovery, and refunds.

```bash
npm install -g @itpay/cli
itpay readyz --json
itpay skill show itpay-buyer --json
itpay install --json
itpay --agent-type codex-desktop readyz --json
# follow next.command: typed skill show, then catalog list
```

The default API is temporarily `https://dev.itpay.ai` during the 2.0.9 beta. Set `ITPAY_BACKEND_URL` only for an intentional override.

## Output Contract

Normal JSON commands return one bounded envelope:

```text
status      current command state
result      facts needed at this step
handoff     optional human-visible URL/image fields for the current Host
instruction how the Agent must use the result
next        zero or one preferred executable command
recovery    exceptional recovery commands only
```

Run `next.command` unchanged after filling only explicit placeholders or user-provided required fields. Do not inspect raw APIs or hardcode a service workflow.

Normative per-command contracts: [CLI Command Reference](docs/cli-reference/index.md).

## Supported Agent Types

| Agent Type | Default Host |
| --- | --- |
| `codex-desktop` | `codex` |
| `codex-cli` | `terminal` |
| `claude-code-desktop` | `claude-code` |
| `claude-code-cli` | `terminal` |
| `workbuddy` | `plain-chat` |

`--agent-type` identifies the stable runtime and registered Agent instance. Every returned ItPay command preserves it. Different windows or chats of the same type reuse one Agent Instance; they are not separate identities. `--host` only selects the human presentation surface, and `--target` only routes output to a Host destination. Use `itpay install <agent_type> --json` for the exact responsibility.

The local installation keeps one Ed25519 private key. Each normalized Backend API base URL (`dev`, `test`, `app`, or local) has an independent server device registration, quota lineage, Agent instances, and sessions. A rejected session is renewed and the same request is retried once; revoked v2 registrations are never silently replaced.

## Command Families

- `readyz`, `catalog list`: compatibility and discovery.
- `services start/invoke/action/checkout/next`: generic Service Execution flow.
- `cart add/show/remove/clear/next`, `buy`: canonical Cart and ordinary Checkout flow.
- `checkout`: authoritative payment and fulfillment recovery.
- `services read-result`: read one human-granted protected result.
- `order`, `orders`: exact order and account order views.
- `refund create/list/get/watch/cancel`: Refund Owner flow.
- `services get/events`: redacted support diagnostics; normal flows should use `services next`.
- `install`, `skill show`, `docs list/show/search`: offline packaged guidance.
- `pay`: operator escape hatch only; normal buyers use the ItPay Checkout page.

Run `itpay <command> --help` or browse [the command index](docs/cli-reference/index.md) for parameters.

## Recovery

Use server-backed recovery before creating another resource:

```bash
itpay --agent-type <agent_type> next --json
itpay --agent-type <agent_type> services list --json
itpay --agent-type <agent_type> services next <service_execution_id> --json
itpay --agent-type <agent_type> services checkout <service_execution_id> --resume --json
itpay checkout --id <checkout_id> --token <display_token> --json
```

The local `~/.itpay-v3` directory stores one owner-only signing key, Backend-scoped Device registrations and Agent instances, idempotency operations, and recovery handles. Backend state remains authoritative. Do not delete or rotate this identity to recover quota.

## Environment

- `ITPAY_BACKEND_URL`: deliberate API override.
- `ITPAY_AGENT_TYPE`: stable alternative to global `--agent-type`.
- `ITPAY_BEARER_TOKEN`: account-scoped Buyer session for account-only commands such as `orders`.
- `ITPAY_CART_SESSION_PATH`: local recovery-state path override.
- `ITPAY_CURRENCY`: ordinary Cart currency, default `CNY`.
- `ITPAY_IDEMPOTENCY_KEY`: explicit operation key for deterministic testing; normal use persists operation IDs automatically.
- `ITPAY_IDE_IMAGE_ATTACH=0`: disable local Checkout image download when the runtime filesystem is read-only.
- `ITPAY_IDE_IMAGE_DIR_OVERRIDE`: override the local Checkout image directory.

Provider credentials, Buyer identity, payment provider choice, amount, refund policy, quota, grant scope, and delivery access are never client-owned environment settings.

## Development

```bash
npm run lint
npm test
npm run test:package
npm run pack:dry-run
```

Source boundaries:

- `src/main.ts`: parser and error-envelope wiring.
- `src/client`: typed HTTP access.
- `src/commands`: command orchestration and public output projection.
- `src/render`: Host presentation only; no business HTTP.
- `src/state`: local Device Authority, idempotency journal, and recovery handles.
- `docs/cli-reference`: normative command contracts.
- `docs/agent/buyer`: packaged progressive workflow guidance.
