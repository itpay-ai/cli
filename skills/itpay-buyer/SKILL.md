---
name: itpay-buyer
description: >
  Use the ItPay CLI when a human asks an Agent to discover services, use a
  capability, buy a result, show a Checkout, recover an interrupted flow,
  read a human-granted result, or manage a refund.
---

# ItPay Buyer

Use the CLI as the only ItPay control surface. Do not recreate API calls or hardcode a service-specific sequence.

## Bootstrap

```bash
npm install -g @itpay/cli
itpay install <agent_type> --json
itpay --agent-type <agent_type> readyz --json
itpay --agent-type <agent_type> docs show quickstart --json
```

Supported types are `codex-desktop`, `codex-cli`, `claude-code-desktop`, `claude-code-cli`, and `workbuddy`. Use the real stable runtime type; Host is presentation only.

## Envelope Rule

For every JSON response:

1. Read `status` and `result` as current facts.
2. Follow `instruction` when explaining or presenting those facts.
3. Execute at most the one `next.command`, filling only explicit placeholders or required user data.
4. Use `recovery` only when the normal next step cannot continue.

Do not print the whole envelope to the user. Return the useful result, a short explanation, and the next human action when needed.

## Golden Flow

```bash
itpay --agent-type <agent_type> catalog list --json
itpay --agent-type <agent_type> services start <service_id> --json
```

Then execute the exact `next.command` returned by each step. It may invoke a capability, ask for a selection, create a Checkout, wait for human action, return an Agent-visible result, or read a protected result after grant.

Rules:

- One independent service intent uses one Service Execution.
- Every candidate list belongs to its source Service Execution. After a human selects a rank, submit the selection on that same Execution; never copy it into a new Execution or construct a candidate.
- A paid step is `services quote -> cart add --quote -> buy --cart`. Quote locks service input and price; Cart may combine Quotes from separate Executions without merging their delivery.
- `services checkout` is the one-item shortcut for the same Quote, Cart and Checkout rules.
- Ask for required email/contact fields; explain their delivery purpose and never invent them.
- When Checkout is ready, make both the ItPay QR/image and URL visible on the current human surface.
- Normal payment happens on the ItPay Checkout page. `itpay pay` and `buy --pay` are operator escape hatches.
- Payment is confirmed only by Backend Checkout or Order state.
- Agent-visible results come from `services next`; do not call `read-result` for them.
- An Execution may have delivery history; always follow `services next` for the backend-selected current delivery instead of reusing an older result.
- Protected results require a current human grant. The grant is scoped to one delivery, approved fields and frozen Agent audience, and expires after 15 minutes.
- A pending refund locks every delivery path and revokes existing grants.

## Recovery

Before creating anything again:

```bash
itpay --agent-type <agent_type> next --json
itpay --agent-type <agent_type> services list --json
itpay --agent-type <agent_type> services next <service_execution_id> --json
itpay --agent-type <agent_type> services checkout <service_execution_id> --resume --json
itpay checkout --id <checkout_id> --token <display_token> --json
itpay --agent-type <agent_type> refund get <refund_request_id> --json
```

## Safety

- Never invent service, capability, item, Checkout, Order, grant, or refund IDs.
- Never expose Provider credentials, raw payloads, display tokens as standalone chat data, Buyer bearer tokens, or Device private keys.
- Never bypass ownership, compatibility, quota, grant, or refund-lock errors.
- Do not use `services events` in a normal flow; it is a bounded redacted diagnostic command.
- Do not rotate Agent Type or local identity to reset free quota.

## Built-In Help

```bash
itpay docs list --json
itpay docs search <term> --json
itpay docs show <topic> --json
```

The normative command contracts are packaged under `docs/cli-reference`.
