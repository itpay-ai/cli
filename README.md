# ItPay CLI

The official V3 CLI and the single ItPay entry point for services, purchases, account history, and human-authorized content reads.

## One Entry Point, Several Human Intents

`itpay` is the only public CLI entry point, and `$itpay` is its user-facing Skill invocation. The Agent first distinguishes a new service request, previously purchased content, order history, or a refund. This public package provides Buyer workflows. Seller source remains maintained separately in this repository.

Follow the official setup link for the authorized channel and matching Backend. Standard npm can use a host-managed persistent tool location or a global prefix; retain one exact executable.

```bash
itpay setup --agent-type <actual_type> --json
# read and enable the same-package Skill returned by setup
```

使用宿主允许的持久安装方式运行官方 ItPay CLI，不要求全局安装。固定本次安装的入口、实际 Agent Type 和 Backend。首次使用或更新后运行 setup；setup_ready 证明设备准备完成，账号授权状态单独列出。完整读取当前包 Skill，并按宿主方式保存启用；同版本已读且已启用时无需重复。业务请求需要真人授权时使用返回的官方入口，不以安装授权代替购买同意。安装位置变化不要求清除设备身份。

The CLI defaults to the production Backend `https://app.itpay.ai`. Explicit test runs may set `ITPAY_BACKEND_URL=https://sandbox.itpay.ai` or `https://dev.itpay.ai`; nonofficial Backend URLs are rejected before network or local state access.

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
| `zcode` | `plain-chat` |
| `doubao-work` | `plain-chat` |
| `kimi-code` | `terminal` |
| `openclaw` | 必须显式提供 |

`--agent-type` identifies the stable runtime and registered Agent instance. Every returned ItPay command preserves it. Different windows or chats of the same type reuse one Agent Instance; they are not separate identities. `--host` only selects the human presentation surface, and `--target` only routes output to a Host destination. Use `itpay install <agent_type> --json` for the exact responsibility.

The local installation keeps one Ed25519 private key and a separate registration for each official Backend, with one Agent Instance per Agent Type under each registration. A rejected session is renewed and the same request is retried once; revoked v2 registrations are never silently replaced.

## Command Families

- `readyz`: selected official Backend liveness; `catalog list`: compatibility-gated discovery.
- `services start/invoke/action/checkout/next`: generic Service Execution flow.
- `cart add/show/remove/clear/next`, `buy`: canonical Cart and ordinary Checkout flow.
- `checkout`: authoritative payment and fulfillment recovery.
- `services read-result`: read saved railway query pages or human-granted protected content.
- `order`, `orders`: exact order and account order views.
- `vault list/access/read`: find and read previously purchased content after time-limited human authorization.
- `refund create/list/get/watch/cancel`: Refund Owner flow.
- `services get/events`: redacted support diagnostics; normal flows should use `services next`.
- `install`, `skill show`, `docs list/show/search`: offline packaged guidance.
- `device recover`: operator-confirmed Backend reset recovery that preserves the local private key.
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

The local `~/.itpay-v3` directory stores one owner-only signing key, Backend-scoped Device registrations and Agent instances, idempotency operations, and recovery handles. Production uses `cart.json` / `operations.json`; sandbox uses `cart.sandbox.json` / `operations.sandbox.json`. Backend state remains authoritative. Do not delete or rotate this identity to recover quota.

## Environment

- `ITPAY_AGENT_TYPE`: stable alternative to global `--agent-type`.
- `ITPAY_BACKEND_URL`: optional sandbox override; only the exact official URL `https://sandbox.itpay.ai` is accepted. Unset it for production.
- `ITPAY_BEARER_TOKEN`: optional account-scoped browser session for authorized account reads. Local Agents normally use signed Device Authority plus the time-limited human authorization returned by `vault access`.
- `ITPAY_CART_SESSION_PATH`: local recovery-state path override.
- `ITPAY_CURRENCY`: ordinary Cart currency, default `CNY`.
- `ITPAY_IDEMPOTENCY_KEY`: explicit operation key for deterministic testing; normal use persists operation IDs automatically.
- `ITPAY_IDE_IMAGE_ATTACH=0`: disable local Checkout and authorization image download when the runtime filesystem is read-only.
- `ITPAY_IDE_IMAGE_DIR_OVERRIDE`: override the local handoff image directory.

Provider credentials, Buyer identity, payment provider choice, amount, refund policy, quota, grant scope, and delivery access are never client-owned environment settings.

## Development

```bash
npm run lint
npm test
npm run test:coverage
npm run test:package
npm run pack:dry-run
```

`npm install` configures the repository's pre-commit hook. Every commit must pass
`npm run lint` and `npm test`; do not bypass the hook for pull-request changes.

Source boundaries:

- `src/main.ts`: parser and error-envelope wiring.
- `src/client`: typed HTTP access.
- `src/commands`: command orchestration and public output projection.
- `src/render`: Host presentation only; no business HTTP.
- `src/state`: local Device Authority, idempotency journal, and recovery handles.
- `docs/cli-reference`: normative command contracts.
- `docs/agent/buyer`: packaged progressive workflow guidance.

### Run a published service

Use `itpay services run <service_id> --input-json ./input.json --json` for a published workflow. The input file must contain a JSON object matching the service input schema. With no input file, the CLI reports required fields and a command to continue the same execution.

Use `itpay services run <service_id> --execution <execution_id> --json` to resume. At payment, the CLI uses the existing Checkout QR/card handoff. The backend continues after verified payment even if the CLI exits. `--timeout <seconds>` controls initial status polling (default 120, maximum 600). Use existing order/refund commands for refund requests; an application is not a successful refund until its final status confirms success.

## Agent preparation

Install the official package using standard npm in one host-permitted persistent tool location or a global prefix. Retain the exact callable entry. Run `itpay setup --agent-type <actual_type> --json`, then read and enable its same-package Skill before business commands. Account login is separate and occurs only when needed. See [setup](docs/cli-reference/commands/setup.md).
