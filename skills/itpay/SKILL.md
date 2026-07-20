---
name: itpay
description: >
  Use the single ItPay entry point when a human asks an Agent to buy or sell
  through ItPay. Buyer workflows cover service discovery, purchase, Checkout,
  delivery, recovery, and refunds. Seller workflows are not yet implemented.
---

# ItPay

Use the CLI as the only ItPay control surface. Never recreate API calls or hardcode a service-specific sequence.

## One Entry Point, Two Action Domains

- `itpay` is the only CLI entry point, and `$itpay` is the only user-facing Skill invocation. Never create or route users to a separate Buyer or Seller entry point.
- `buy` and `sell` are the two top-level ItPay action domains.
- Buyer workflows are available now. Seller workflows will use this same `itpay` entry point, but are not implemented in the current release.
- Do not invent Seller commands, onboarding, listings, or successful Seller state before that workflow ships.

## Critical Rules

- The production CLI Backend is fixed to `https://app.itpay.ai`. Never use an environment variable, alternate launcher, or recovery path to redirect it.
- Keep one honest Agent Type, one CLI/Node launcher, and one Host-approved permission context for the whole flow. Supported types: `codex-desktop`, `codex-cli`, `claude-code-desktop`, `claude-code-cli`, `workbuddy`.
- WorkBuddy: before any ItPay Bash command that persists `~/.itpay-v3`, set the Shell tool parameter `dangerouslyDisableSandbox` to `true`. If the human denies that permission, the command did not run: stop and report it.
- Windows, tasks, chats, processes, and model sessions are not new Agents. Never rotate Agent Type or identity to reset quota.
- Treat `next.command` as the preferred continuation, not an unconditional command. If the current result already satisfies the user's stated goal, present it and stop.
- Keep internal parsing, retries, sandbox diagnosis, and command translation out of the user response; report useful progress, results, and real human decisions only.
- If Device state is not writable, stop. Do not switch Node, manually create lock files, delete identity, or rotate Agent Type.

## Bootstrap

```bash
npm install -g @itpay/cli
itpay readyz --json
itpay skill show itpay --json
itpay install --json
itpay install <agent_type> --json
itpay --agent-type <agent_type> readyz --json
```

Follow the returned `next.command`. After typed `readyz`, read this complete Skill again, then continue to Catalog.

If `backend_contract_incompatible` returns `result.required_cli_version`, stop every ItPay business command. Run only its exact `npm install -g @itpay/cli@<version>` recovery; never substitute `latest`. Confirm `itpay --version` exactly matches the required version, then restart with typed `readyz`. Never change Agent Type or Device identity to bypass compatibility.

## Identity And Sessions

- One local Ed25519 private key represents this ItPay installation. Never expose, copy, or rotate it to recover quota.
- The CLI uses one production Device registration at `https://app.itpay.ai` with one Agent Instance per `agent_type`. Different windows and chats of the same type reuse it; different types get separate instances under that registration.
- Every commerce command must keep the explicit `--agent-type` returned in `next` and `recovery`, or use one stable `ITPAY_AGENT_TYPE`. Never fall back to another type previously used on the machine.
- The CLI renews an expired or rejected device session and retries the same request exactly once. If that retry still fails, stop and report it; do not loop, create a new identity, or switch Agent Type.
- A revoked v2 device is not replaced automatically. It requires an explicit operator recovery path.
- If an operator confirms that the `https://app.itpay.ai` Device registration database was reset, use `device recover --confirm-backend-reset`. This preserves the private key; never use it for ordinary session expiry or revocation.
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
- WorkBuddy with `plain-chat`: when `handoff.qr_image_url` exists, use its complete value as the only `files` element in `present_files`; confirm the right-side QR preview opened, show amount and `handoff.url`, then stop. If it is absent, send amount and `handoff.url`, do not call `present_files`, then stop.
- If WorkBuddy `present_files` fails, send only `handoff.url`, report the failure, and stop. Never inspect files, switch Node, rebuild a QR, call `pay`, or create another Checkout.
- An explicit `--host` overrides presentation only. It never changes Agent identity or payment state.

Run `next.command` only after the human says they acted or asks for status. QR rendering, redirects, and human claims are not payment proof; only Backend Checkout or Order state is. Normal payment uses the Checkout page; `pay` and `buy --pay` are operator escape hatches, never recovery.

## Delivery And Refunds

- Agent-visible results come from `services next`; do not use `read-result` for them.
- Protected results require a current 15-minute human grant scoped to one delivery, approved fields, and frozen Agent audience.
- If `services next` returns `result_preparing`, authorization is already complete. Run only its same-Execution `next.command`; do not pay, authorize, start, or call `read-result` again.
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

`provider_connection_unavailable` is a terminal exception: Backend confirms no Provider request was sent and releases the reservation, then fails that Execution. Stop with no recovery command. Only after an operator confirms connectivity is restored and the human explicitly asks to query again may you start a new Execution.

`no_result` is a completed Provider call with zero items. Show the query, zero results, and the returned quota, then stop. Never shorten, rewrite, or guess another input. `provider_input_rejected`, `provider_temporarily_unavailable`, and `provider_contract_mismatch` are also terminal for the current request: report the exact safe message and quota facts, run no recovery command, and wait for a new explicit human request.

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
itpay skill show itpay --json
```

Normative command contracts are packaged under `docs/cli-reference`.
