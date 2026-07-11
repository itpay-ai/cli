---
name: itpay-buyer
description: >
  Use the ItPay V3 CLI when a human asks an AI agent to discover services,
  use a free capability, buy a paid result, show an ItPay checkout QR, recover
  an interrupted purchase, or read a result covered by a temporary human grant.
---

# ItPay V3 Buyer

Use the CLI as the control surface. Do not recreate ItPay API calls or invent a
service-specific workflow. The backend returns the next valid actions for each
catalog item and Service Execution.

## Bootstrap

```bash
npm install -g @itpay/cli
itpay readyz
itpay docs show quickstart
```

The CLI defaults to `https://app.itpay.ai`. Set `ITPAY_BACKEND_URL`
only for an intentional override.

Every commerce flow must identify the real runtime. Pass the global option
immediately after `itpay`, or set `ITPAY_AGENT_TYPE` once:

```bash
itpay --agent-type codex-desktop catalog list --json
```

Examples include `codex-desktop`, `codex-cli`, `claude-code-desktop`,
`claude-code-cli`, and the actual WorkBuddy/OpenClaw runtime name. Never rotate
the type or local device files to obtain more free quota. The CLI enrolls one
signed device under `~/.itpay-v3/device` and registers each runtime on it.

## Golden Flow

1. Discover, then use IDs returned by the CLI:

```bash
itpay --agent-type <agent_type> catalog list --json
itpay --agent-type <agent_type> services start <service_id>
```

2. Ask the server for the next step:

```bash
itpay --agent-type <agent_type> services next <service_execution_id> --json
```

3. Execute the first applicable command from `next_actions` unchanged. Typical
commands are `services invoke`, `services action`, or `services checkout`.
Do not infer a capability ID or hardcode one service's sequence.

4. For a paid result, collect only contact fields requested by the CLI. Create
the checkout with the exact server-selected capability:

```bash
itpay --agent-type <agent_type> services checkout <service_execution_id> \
  --capability <capability_id> [--email <human_email>] --host <host> --json
```

Include `--email` only when the CLI's `next_actions` command includes it. For a
protected delivery, explain that the address receives the order claim link;
never invent an address. Agent-visible paid results do not require email.

5. Show both handoff forms to the human:

- Attach `brand_qr_local_path` when `brand_qr_status` is `downloaded`.
- Print `checkout_url` as a clickable link.
- Keep `checkout_id`, `display_token`, and `service_execution_id` for recovery.
- Do not substitute a provider QR or call `itpay pay` in the normal buyer flow.

6. After the human pays, claims, or grants access, re-read server state:

```bash
itpay --agent-type <agent_type> services next <service_execution_id> --json
itpay --agent-type <agent_type> services get <service_execution_id> --json
```

7. Read protected output only when `next_actions` says the human grant is
active:

```bash
itpay --agent-type <agent_type> services read-result <service_execution_id>
```

The grant is scoped to one Service Execution and expires after 15 minutes. It
does not expose the buyer's other Vault artifacts, orders, or executions.

## Recovery

Use server-backed recovery before creating anything again:

```bash
itpay --agent-type <agent_type> next --json
itpay --agent-type <agent_type> services list --json
itpay --agent-type <agent_type> services next <service_execution_id> --json
itpay --agent-type <agent_type> services checkout <service_execution_id> --resume --json
itpay checkout --id <checkout_id> --token <display_token>
```

`--resume` reissues the handoff for the existing unpaid checkout. It must not
create a second order. Local files cache recovery handles; canonical cart,
quota, execution, checkout, delivery, and grant state comes from the backend.

## Host Selection

`--agent-type` identifies the agent runtime. `--host` identifies where the
human sees the output. They are separate.

| Human surface | CLI options |
| --- | --- |
| Codex | `--host codex` |
| Claude Code | `--host claude-code` |
| Terminal | `--host terminal` |
| Telegram | `--host telegram --target <chat_id>` |
| Feishu/Lark | `--host feishu --target <id>` or `--host lark --target <id>` |

Run `itpay install <host>` for host-specific setup.

## Progressive Disclosure

- Run one state-changing command at a time.
- Return the useful result, a short explanation, and the next executable step.
- Ask the human only for a missing required field such as delivery email.
- When checkout is ready, visibly attach the QR and print the payment link.
- Prefer CLI `next_actions`; do not dump internal timelines unless diagnosing.
- Use `--json` for agent parsing and normal rendering for the human handoff.

## Safety Rules

1. Never invent catalog, service, capability, result-item, checkout, or order IDs.
2. Never expose provider credentials, raw provider metadata, bearer tokens, or device private keys.
3. Do not treat QR rendering or a human statement as payment confirmation.
4. Do not call `itpay pay` or use `buy --pay` for a normal checkout; those are operator escape hatches.
5. Do not create a new execution or checkout until recovery confirms the prior one is unusable.
6. Do not claim protected access before `services read-result` succeeds.
7. Do not invent admin, account, grant-creation, or provider-specific CLI commands.

## Built-in Docs

```bash
itpay docs list
itpay docs search <term>
itpay docs show catalog-list
itpay docs show cart-checkout
itpay docs show payment-flow
itpay docs show orders-refunds
itpay docs show render-hosts
itpay docs show install-and-setup
```
