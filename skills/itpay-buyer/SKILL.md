---
name: itpay-buyer
description: >
  Use the ItPay CLI when a human asks an Agent to discover services, use a
  capability, buy a result, show a Checkout, recover an interrupted flow,
  read a human-granted result, or manage a refund.
---

# ItPay Buyer

Use the CLI as the only ItPay control surface. Do not recreate API calls or hardcode a service-specific sequence.

## Critical Rules

- Keep one honest Agent Type, one CLI/Node launcher, and one Host-approved permission context for the whole flow.
- Treat `next.command` as the preferred continuation, not an unconditional command. If the current result already satisfies the user's stated goal, present it and stop.
- Keep internal parsing, retries, sandbox diagnosis, and command translation out of the user response; report useful progress, results, and real human decisions only.
- If Device state is not writable, stop. Do not switch Node, manually create lock files, delete identity, or rotate Agent Type.

## Bootstrap

```bash
npm install -g @itpay/cli
itpay readyz --json
itpay skill show itpay-buyer --json
itpay install --json
itpay install <agent_type> --json
itpay --agent-type <agent_type> readyz --json
```

Follow each returned `next.command`. `readyz` deliberately points back to this complete Skill. If the Skill was read without an Agent Type, choose the real runtime with `install`; after typed `readyz`, read the Skill again and continue to Catalog.

Supported types are `codex-desktop`, `codex-cli`, `claude-code-desktop`, `claude-code-cli`, and `workbuddy`. State the real stable runtime type honestly. Do not identify a window, chat, task, process, or model session as a new Agent.

## Identity And Sessions

- One local Ed25519 private key represents this ItPay installation. Never expose, copy, or rotate it to recover quota.
- Device registrations are scoped by exact Backend API base URL. `dev`, `test`, and `app` therefore have separate server device IDs, quota lineage, Agent instances, and sessions while using the same local key.
- Each Backend registration has one Agent Instance per `agent_type`. Different windows and chats of the same type reuse it; different types get separate instances under that registration.
- Every commerce command must keep the explicit `--agent-type` returned in `next` and `recovery`, or use one stable `ITPAY_AGENT_TYPE`. Never fall back to another type previously used on the machine.
- The CLI renews an expired or rejected device session and retries the same request exactly once. If that retry still fails, stop and report it; do not loop, create a new identity, or switch Agent Type.
- A revoked v2 device is not replaced automatically. It requires an explicit operator recovery path.
- If an operator confirms that one Backend registration database was reset, use `device recover --confirm-backend-reset` for that selected Backend only. This preserves the private key and every other Backend registration; never use it for ordinary session expiry or revocation.
- `--host` selects presentation. `--target` is only the destination chat/channel/open ID required by some Hosts. Neither is business input or identity.

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

`services start` creates the Execution and returns the preferred capability plus its `required_input`. Put business values only in repeated `--input key=value` options on the returned `services invoke`, `services quote`, or `services checkout` command. For example, a company keyword belongs in `--input keyword=美团`; it never belongs in `--target`.

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
itpay --agent-type <agent_type> checkout --id <checkout_id> --token <display_token> --json
itpay --agent-type <agent_type> refund get <refund_request_id> --json
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
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
itpay skill show itpay-buyer --json
```

The normative command contracts are packaged under `docs/cli-reference`.
