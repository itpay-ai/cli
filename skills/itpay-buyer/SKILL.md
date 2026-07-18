---
name: itpay-buyer
description: >
  Use the ItPay CLI when a human asks an Agent to discover services, use a
  capability, buy a result, show a Checkout, recover an interrupted flow,
  read a human-granted result, or manage a refund.
---

# ItPay Buyer

Use the CLI as the only ItPay control surface. Never recreate API calls or hardcode a service-specific sequence.

## Envelope Rule

- Keep one honest Agent Type, CLI/Node launcher, and Host permission context. Supported types: `codex-desktop`, `codex-cli`, `claude-code-desktop`, `claude-code-cli`, `workbuddy`.
- Windows, tasks, chats, processes, and model sessions are not new Agents. Never rotate Agent Type or identity to reset quota.
- Read `status` and `result` as facts, follow `instruction`, and execute at most the applicable `next.command`; use `recovery` only when it cannot continue.
- `next.command` is not unconditional. If the result satisfies the user's goal, present useful facts and stop; never dump the whole envelope.

## Bootstrap

```bash
npm install -g @itpay/cli
itpay readyz --json
itpay skill show itpay-buyer --json
itpay install --json
itpay install <agent_type> --json
itpay --agent-type <agent_type> readyz --json
```

Follow the returned `next.command`. After typed `readyz`, read this complete Skill again, then continue to Catalog.

## Identity And Sessions

- One local Ed25519 private key represents this installation. Never expose, copy, delete, or rotate it during normal recovery.
- `dev`, `test`, and `app` have separate Device registrations under the same key. Each registration has one Agent Instance per `agent_type`; same-type windows reuse it.
- Keep the returned `--agent-type` on every commerce command, or use one stable `ITPAY_AGENT_TYPE`. `--host` is presentation and `--target` is routing; neither is identity or business input.
- The CLI may renew a rejected/expired session and retry once. If it still fails or Device state is not writable, stop; do not loop, switch Node, edit locks, inspect credentials, or change identity.
- Use `device recover --confirm-backend-reset` only after an operator confirms that Backend was reset. It preserves the key and other Backend registrations.

## Golden Flow

```bash
itpay --agent-type <agent_type> catalog list --json
itpay --agent-type <agent_type> services start <service_id> --json
```

Then follow each returned `next.command` on the same Service Execution.

- Put business input only in repeated `--input key=value` options. A keyword such as `美团` never belongs in `--target`.
- One independent service intent uses one Service Execution.
- Candidate lists belong to their source Execution. Ask the human to select a displayed rank, then submit it on that same Execution; never construct a candidate ID.
- Before a paid step, show the exact price, ask for required contact fields with their purpose, and wait for explicit human agreement. Never invent contact data.
- A normal single-Execution purchase uses the exact returned `services checkout` command.
- `services quote -> cart add --quote -> buy --cart` is only for a human who explicitly asks to combine Quotes from multiple independent Executions. It is not failure recovery.

## Checkout Handoff

When `status` is `human_checkout_required`, make the amount, ItPay Checkout QR, and `handoff.url` visible on the current human surface, then stop.

- Desktop Agents: send `handoff.markdown` unchanged; confirm QR, amount, and link are visible, then stop.
- CLI Agents: show the terminal QR, amount, and link in the watched terminal, then stop; never claim a desktop image was shown.
- WorkBuddy with `plain-chat`: use the complete `handoff.qr_image_url` as the only `files` element in `present_files`. Confirm the right-side QR preview opened, show amount and `handoff.url`, then stop.
- If WorkBuddy `present_files` fails, send only `handoff.url`, report the failure, and stop. Never inspect files, switch Node, rebuild a QR, call `pay`, or create another Checkout.
- An explicit `--host` overrides presentation only. It never changes Agent identity or payment state.

Run `next.command` only after the human says they acted or asks for status. QR rendering, redirects, and human claims are not payment proof; only Backend Checkout or Order state is. Normal payment uses the Checkout page; `pay` and `buy --pay` are operator escape hatches, never recovery.

## Delivery And Refunds

- Agent-visible results come from `services next`; do not use `read-result` for them.
- Protected results require a current 15-minute human grant scoped to one delivery, approved fields, and frozen Agent audience.
- An Execution may have delivery history; follow `services next` for the Backend-selected current delivery.
- A pending refund locks delivery and revokes active grants. Follow the returned refund command and state.

## Recovery

Before creating anything again, use only the applicable read/resume command:

```bash
itpay --agent-type <agent_type> next --json
itpay --agent-type <agent_type> services list --json
itpay --agent-type <agent_type> services next <service_execution_id> --json
itpay --agent-type <agent_type> services checkout <service_execution_id> --resume --json
itpay --agent-type <agent_type> checkout --id <checkout_id> --token <display_token> --json
itpay --agent-type <agent_type> refund get <refund_request_id> --json
```

Reuse the same Execution and Checkout. Never start another Execution, create another Checkout, change payment route, or replay a capability to bypass quota, selection, payment, delivery, grant, or refund state.

## Safety

- Never invent service, capability, item, Checkout, Order, grant, or refund IDs.
- Never expose Provider credentials, raw payloads, display tokens as standalone chat data, Buyer bearer tokens, or Device private keys.
- Never bypass ownership, compatibility, quota, grant, or refund-lock errors.
- Do not use `services events` in a normal flow; it is a bounded redacted diagnostic command.
- Keep retries, sandbox diagnosis, and command translation out of the user response. Report useful progress, results, and genuine blockers.

## Built-In Help

```bash
itpay docs list --json
itpay docs search <term> --json
itpay docs show <topic> --json
itpay skill show itpay-buyer --json
```

Normative command contracts are packaged under `docs/cli-reference`.
