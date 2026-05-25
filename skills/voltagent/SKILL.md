---
name: voltagent
description: >
  Use VoltaGent when the user asks an AI agent to buy, recharge, configure,
  install, test, diagnose, or use an ITPay/VoltaGent model package for Codex,
  Claude Code, or OpenClaw. This skill is an executable runbook for the `itp`
  CLI.
---

# VoltaGent / ITPay Agent Runbook

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
6. Do not modify, shorten, summarize, re-encode, or rewrite cashier URLs.
7. Do not trust "I paid" as proof of payment.
8. Only `itp setup --json` returning `status=installed`, or `itp payment wait
   <checkout_id> --json` returning `status=grant_issued` / `status=grant_installed`
   with a `grant_id`, means installation may proceed.
9. If a command fails, report the failed command and safe error message. Do not
   dump local credential files.
10. Prefer continuing from existing orders/grants over creating duplicate
    checkouts.

## Runtime Target

Choose exactly one target:

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
- If unclear, ask one short question: "安装到 Codex、Claude Code 还是 OpenClaw？"

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

## Quick Health Check

```bash
itp --version
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

For a normal purchase/install request, prefer the high-level setup command:

```bash
itp setup --plan coding-100 --target <target> --method alipay --json
```

This command checks the current session, starts Alipay device authentication if
needed, creates the checkout, waits for verified payment, installs the grant,
and writes the target runtime config. If it returns `status=installed`, report
the returned base URL fields and stop.

If setup is intentionally run with `--no-wait`, `status=waiting_human_auth`
means the user must scan the Alipay auth URL/code before checkout can be
created, and `status=waiting_human_payment` means the user must scan/pay the
returned cashier URL before installation can continue.

For local fake-auth/fake-payment testing only:

```bash
itp setup --plan coding-100 --target <target> --method fake --mock-approve --offline --json
```

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

For local fake-auth testing only:

```bash
itp auth register --runtime <target> --mock-approve --json
```

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

Default plan for "100 元 coding 模型包" or a generic coding package request:

```text
coding-100
```

If the user asks for a different plan and it exists in `itp plans --json`, use
that plan ID. If no matching plan exists, explain the available plans.

## Checkout

Production/default payment:

```bash
itp checkout create --plan coding-100 --method alipay --json
```

Local or explicit fake-payment testing:

```bash
itp checkout create --plan coding-100 --method fake --idempotency-key <stable-key> --json
```

Use a stable idempotency key when retrying the same user request. Do not create
multiple orders for the same request.

If the checkout response contains `payment.cashier_url`:

1. Preserve the URL exactly.
2. If an official payment/Alipay skill is available, invoke it with the exact
   URL.
3. If no payment skill is available, show the URL to the user and ask them to
   complete payment.

If the checkout response already contains `grant_id` and `status=grant_issued`,
continue directly to grant install.

## Payment Wait / Recovery

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

## Runtime Config Install

Install into the selected runtime:

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
install status
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
