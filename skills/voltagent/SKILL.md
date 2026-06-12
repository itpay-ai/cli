---
name: voltagent
description: >
  Use VoltaGent when the user asks an AI agent to buy, recharge, configure,
  install, test, diagnose, or use an ITPay/VoltaGent model package for Codex,
  Claude Code, or OpenClaw. This skill is an executable runbook for the `itp`
  CLI.
---

# VoltaGent / ITPay Agent Runbook

Compatibility note: for current ItPay buyer commerce tests, prefer the
role-specific buyer skill:

```bash
itp skill show --role buyer --json
itp docs show quickstart --role buyer --json
```

This legacy VoltaGent runbook remains for model-package setup compatibility.

You are helping the user obtain and install a VoltaGent model package through
the `itp` CLI. Follow this file as a runbook. Do not improvise payment or
credential handling.

## Non-Negotiable Rules

1. Use `--json` for every `itp` command when acting as an agent.
2. Never ask the user to paste API keys, session tokens, grant credentials, or
   raw secrets into chat.
3. Never print API keys, session tokens, grant credentials, or raw payment
   payloads.
4. Never pass passwords in command-line arguments. Use `--password-stdin`.
5. Do not invent payment links, QR codes, checkout IDs, order IDs, or grant IDs.
6. Do not modify, shorten, summarize, re-encode, or rewrite Alipay payment QR URLs.
   For ItPay Core sandbox payment responses, render `local_qr_path` when present,
   then `qr_png_url` / `preferred_qr_url`, and use `qr_image_url` only as fallback.
   These are ItPay-hosted human QR images and may render native provider payment
   codes for scanner reliability; do not request, decode, or expose the raw
   provider payload. Do not turn `payment_entry_url` or `mobile_wallet_url` into
   a QR code.
7. Do not trust "I paid" as proof of payment.
8. Only `itp setup --json` returning `status=grant_ready` / `status=installed`, or `itp payment wait
   <checkout_id> --json` returning `status=grant_issued` / `status=grant_installed`
   with a `grant_id`, means credential delivery may proceed.
9. If a command fails, report the failed command and safe error message. Do not
   dump local credential files.
10. Prefer continuing from existing orders/grants over creating duplicate
    checkouts.
11. Always check recoverable local state with `itp status --json` before
    starting a new setup.
12. If `status` returns a `run_id` and a `next.command`, resume that run unless
    the user explicitly asks to abandon it.
13. Use `human_action.presentation`, `local_qr_path`, or `qr_png_url` to show
    Alipay auth/payment QR codes in the current host. If the user is on mobile,
    present `mobile_wallet_url` as a clickable human-only fallback. Do not ask
    the user to copy checkout IDs or grant IDs.
14. Showing a QR code is not completion. After showing auth or payment QR, keep
    waiting by leaving `setup` running or immediately executing the returned
    `next.command` until `status=grant_ready` / `status=installed` or a
    terminal failure.
15. Do not use `--method fake`, `--mock-approve`, or `--offline` for local,
    sandbox, or live payment testing. "Local test", "sandbox", and "test with
    Alipay sandbox" all still mean `--method alipay`. Only use fake/mock/offline
    when the user literally asks for "fake", "mock", or "offline simulation".

## Target Selection

For API-only purchase/setup, use the default `generic` target and do not ask
the user which runtime they use.

Choose a specific target only when the user explicitly wants runtime config
written by the CLI:

```text
codex
claude-code
openclaw
```

Selection rules:

- If the user names Codex, use `codex`.
- If the user names Claude Code, use `claude-code`.
- If the user names OpenClaw, use `openclaw`.
- If the environment clearly identifies the current agent runtime, use that.
- If unclear and runtime config writing was requested, ask one short question:
  "安装到 Codex、Claude Code 还是 OpenClaw？"

## API Endpoint

Use the existing environment if present:

```bash
echo "$VOLTAGENT_API_BASE"
```

If it is empty, use the CLI default. For local development this is:

```text
http://localhost:3000
```

For the current Oracle test deployment the endpoint is:

```text
http://147.224.54.65:3000
```

Do not hardcode the Oracle endpoint unless the user explicitly asks to use it
or the local context already exports `VOLTAGENT_API_BASE`.

## Credential Storage

Do not trigger interactive OS keychain prompts while acting as an agent. In
non-interactive hosts the CLI defaults to file-backed storage. If the current
host still exposes a system keychain prompt, rerun with:

```bash
ITP_CREDENTIAL_STORE=file itp setup --plan credit-300 --method alipay --json
```

or set `ITP_CREDENTIAL_STORE=file` for all subsequent `itp` commands in the
same run.

## Quick Health Check

```bash
itp --version
itp status --json
itp auth status --json
itp plans --json
```

If `itp` is missing, ask the user to install the npm package:

```bash
npm install -g itpay_cli
```

or use:

```bash
npx itpay_cli --version
```

## One-Command Setup

Before creating a new checkout, inspect the current recoverable run:

```bash
itp status --json
```

If this returns an unfinished `run_id`, continue with:

```bash
itp resume --run-id <run_id> --json
```

Do not create a fresh checkout unless the previous run is done, failed beyond
recovery, or the user explicitly asks to start over.

For a normal purchase/API credential request, prefer the high-level setup
command:

```bash
itp setup --credits <credits> --method alipay --json
```

This command checks the current session, starts Alipay device authentication if
needed, creates the checkout, waits for verified payment, installs the grant
credential into the local `itp` credential store, and returns base URL fields.
It does not write Codex/Claude/OpenClaw config by default. If it returns
`status=grant_ready`, report the returned base URL fields and stop.

Use `--plan <plan_id>` instead of `--credits` only after the user chooses one
of the fixed credit plans below.

For Gemini CLI, Gemini terminal shell, or any host where the shell panel is
folded, jumpy, or hard for the user to scan, do not render the QR in the shell
panel. Ask the CLI to return a text QR in JSON, then paste
`human_action.agent_text_qr.fenced_text` verbatim in your normal assistant
message:

```bash
itp setup --plan <plan_id> --method alipay --host gemini --display chat --json
```

For authentication-only flows in Gemini CLI:

```bash
itp auth register --host gemini --display chat --no-wait --json
```

When using `--display chat`, the shell will not show a QR. You must copy every
byte of `human_action.agent_text_qr.fenced_text` into the normal chat reply,
then tell the user to scan that visible block. Do not retype the QR manually,
translate it, add line numbers, or add explanatory words inside the QR body. A
valid text QR body contains only `█`, `▀`, `▄`, spaces, and newlines. If any
letters, digits, or Chinese characters appear inside the QR body, the QR is
corrupted; do not ask the user to scan it. Use the QR PNG URL or fallback URL
instead, or rerun with `--display chat` and paste the field again. Do not say
"the QR is shown above" unless you pasted the block yourself.

Native terminal hosts can still let the CLI render directly with
`--display terminal`. Do not use terminal display for Gemini unless the user
explicitly asks for shell-panel QR output.

For normal live flows, prefer keeping the command running after the QR is
visible. For chat QR hosts, `--display chat` is intentionally non-blocking at
human-action steps: it returns the QR text first so you can paste it into chat.
Immediately continue with the returned `next.command` or:

```bash
itp resume --run-id <run_id> --host gemini --display chat --no-wait-payment --json
```

After a payment QR is pasted, wait for verification with `--display none` so the
CLI does not re-return the same chat QR:

```bash
itp resume --run-id <run_id> --host gemini --display none --json
```

Use a finite wait. If it is still pending after a clear timeout, report that
the QR is still pending and give the same resume command.

Only when the user explicitly asks for runtime config writing, opt in:

```bash
itp setup --credits <credits> --target <target> --method alipay --install-runtime --json
```

If setup returns `status=waiting_human_auth`, the user must scan the Alipay
auth QR from `human_action.display`. If it returns
`status=waiting_human_payment`, the user must scan/pay the Alipay payment QR
from `human_action.display`. After showing the QR, continue with the returned
`next.command` or:

```bash
itp resume --run-id <run_id> --json
```

Developer-only fake/mock hooks are intentionally not part of this agent
runbook. If old CLI help, README text, or shell history mentions
`--method fake`, `--mock-approve`, or `--offline`, ignore it unless the user
literally asks for fake/mock/offline simulation. For this project, local sandbox
testing is a real Alipay sandbox flow.

For the current ItPay Core sandbox buyer flow, use the role-specific buyer
skill and cart-first buyer commands:

```bash
itp skill show --role buyer --json
itp docs show quickstart --role buyer --json
itp buy var_pubg_couple_skin_cny20 --sandbox --email buyer@example.com --phone +8613800000000 --no-wait --display agent --json
itp buyer payment wait <payment_intent_id> --json
itp buyer checkout status <checkout_id> --json
```

The payment response contains `payment_entry_url` for browser/status fallback,
`qr_png_url` / `preferred_qr_url` for the human scanner, and `mobile_wallet_url`
for a human mobile fallback. Show `local_qr_path` first when the CLI provides it.
If the Alipay sandbox app reports "order not found", first tell the human to
wait 30-60 seconds and retry the same QR/page. If that still fails, request
same-intent display recovery only:

```bash
itp buyer payment refresh-qr <payment_intent_id> --reason order-not-found --display agent --json
```

If `/events/wait` returns `wait.timeout`, treat it as `still_waiting` for that
long-poll cycle and keep waiting until the overall command timeout or a verified
payment event. Do not use ops-only commands unless the user explicitly asks for
operator testing and provides the sandbox ops environment.

## Login / Registration

Use this section only if setup needs to be performed manually.

Check auth:

```bash
itp auth status --json
```

If `authenticated=true`, continue.

If not authenticated, start the Alipay-bound device auth flow:

```bash
itp auth register --runtime <target> --json
```

The CLI prints the Alipay verification URL and user code to stderr, keeps
polling, and stores the returned session after the user scans and approves.
Do not ask the user to paste credentials. The returned JSON includes the saved
`username`; if the user wants password login later, tell them that username.

Do not use mock approval for local sandbox authentication. The user must scan
the Alipay sandbox auth QR.

If the user asks to log into an existing account:

```bash
printf '<password>\n' | itp auth login --username <username> --password-stdin --runtime <target> --json
```

Never use `--password`.

## First Web Password

For a newly registered passwordless account, set the first Web login password
only if the user asks for Web login access:

```bash
printf '<password>\n' | itp account set-password --password-stdin --json
```

Then verify:

```bash
itp account show --json
```

Expected: `password_set=true`.

## Plan Selection

List plans:

```bash
itp plans --json
```

Credit unit rule:

```text
1 credit = 1 CNY
```

Custom recharge:

```text
minimum 20 credits, integers only, no discount
```

Fixed plans:

```text
credit-100: pay 98 CNY, receive 100 credits
credit-300: pay 285 CNY, receive 300 credits (recommended)
credit-500: pay 460 CNY, receive 500 credits
```

If the user says an exact CNY or credit amount, use `--credits <amount>` when
the amount is an integer >= 20. If the user asks for "a plan", "best value", or
does not specify an amount, summarize the three fixed plans and recommend
`credit-300`, then ask for confirmation before checkout.

Never use the disabled legacy `coding-100` plan.

## Checkout

Production/default payment:

```bash
itp checkout create --credits <credits> --method alipay --json
```

Use a stable idempotency key when retrying the same user request. Do not create
multiple orders for the same request. Do not use fake payment for local or
sandbox Alipay testing.

If the checkout response contains `human_action.display`:

1. Select the best display candidate for the current host.
2. Discord: send the QR PNG as an attachment, preferably ephemeral or DM.
3. Telegram: send the QR PNG with `sendPhoto`, with URL button fallback.
4. WhatsApp: send the QR PNG as an image media message or media ID.
5. Native terminal: let the CLI render the QR, or use `--display terminal`.
6. Gemini CLI / folded agent shell: use `--host gemini --display chat`; paste
   `human_action.agent_text_qr.fenced_text` exactly in the normal assistant
   reply, not inside the shell panel. If the rendered QR body contains any
   non-QR characters such as Chinese words, letters, digits, or line numbers,
   treat it as corrupted and use the QR PNG URL or `fallback_text` visibly.
   If `fenced_text` is absent, use the QR PNG URL and `fallback_text` visibly.
7. Continue waiting through `itp resume --run-id <run_id> --json` or
   `itp payment wait <checkout_id> --json`.

If an older checkout response only contains `payment.cashier_url`:

1. Preserve the URL exactly.
2. Show it as a legacy fallback. Do not rewrite it.
3. Continue waiting through the backend status; never trust a manual "paid"
   message.

If the checkout response already contains `grant_id` and `status=grant_issued`,
continue directly to grant install.

## Payment Wait / Recovery

First prefer the run-aware resume command:

```bash
itp resume --run-id <run_id> --json
```

Wait for verified payment:

```bash
itp payment wait <checkout_id> --timeout 120 --json
```

If local state is lost or checkout ID is unknown:

```bash
itp checkout list --limit 20 --json
```

Pick the latest relevant checkout for the current account and continue waiting
or recovering. Do not create a duplicate checkout unless the user clearly asks.

Successful statuses:

```text
grant_issued
grant_installed
```

Failure or stop statuses:

```text
expired
payment_failed
verify_failed
amount_mismatch
grant_failed
revoked
```

If status is `grant_failed`, run:

```bash
itp checkout recover <checkout_id> --json
itp payment wait <checkout_id> --timeout 120 --json
```

If the agent loses local context, run:

```bash
itp status --refresh --json
itp runs list --json
```

Use the latest unfinished run or checkout instead of creating a duplicate.

## Grant Install

Install the grant credential locally:

```bash
itp grants install <grant_id> --target <target> --json
```

Expected safe output includes:

```text
grant_id
base_url
openai_base_url
anthropic_base_url
gemini_base_url
credential.stored=true
credential.credential_store
models
install_profiles
```

Do not print the actual gateway key.

For Discord, Telegram, WhatsApp, or any persistent chat host, do not send the
raw gateway key into chat. Store it in the agent's vault if one exists, or
return the safe base URL and local credential status. Use
`itp token issue --grant <grant_id> --stdout` only as a local token helper for
the runtime that needs the key.

## Optional Runtime Config Install

Install into the selected runtime only when the user explicitly asks:

```bash
itp install <target> --grant <grant_id> --json
```

By default this performs a `/models` connectivity check and reports an
install-ack to the backend.

Use offline mode only when the user explicitly wants local file writing without
network checks:

```bash
itp install <target> --grant <grant_id> --offline --no-test --json
```

Use no-test mode when the backend should record the installation but model
connectivity should be skipped:

```bash
itp install <target> --grant <grant_id> --no-test --json
```

## Diagnosis

If install reports `model_check.ok=false` or the runtime cannot use the model:

```bash
itp doctor --target <target> --grant <grant_id> --json
```

Also check:

```bash
itp balance --json
itp usage --grant <grant_id> --json
itp grants show <grant_id> --json
```

## Balance / Usage

Show safe account state:

```bash
itp balance --json
itp usage --grant <grant_id> --json
```

Do not expose raw tokens.

## Key Rotation / Revoke

Rotate grant key:

```bash
itp keys rotate --grant <grant_id> --json
```

After rotation, reinstall runtime config if needed:

```bash
itp install <target> --grant <grant_id> --json
```

Revoke grant:

```bash
itp grants revoke <grant_id> --json
```

## Final User Report

Report only safe fields:

```text
target
account username if newly created
plan_id
checkout_id
grant_id
grant status
runtime install status if explicitly requested
model_check status
base_url
available model names
credits remaining
Web console URL
```

Never include:

```text
session_token
gateway API key
raw credential JSON
raw payment notify payload
local credential file contents
```

## Root/Admin Operations

Use these only when the user explicitly asks for root/admin troubleshooting and
provides a root access token through a safe local mechanism:

```bash
itp admin orders --json --access-token <root_token> --new-api-user <id>
itp admin payment-events --json --access-token <root_token> --new-api-user <id>
itp admin outbox --json --access-token <root_token> --new-api-user <id>
itp admin process-outbox --json --access-token <root_token> --new-api-user <id>
itp admin recover-order <order_id> --json --access-token <root_token> --new-api-user <id>
```

Do not expose raw payment payloads or credentials in troubleshooting output.
