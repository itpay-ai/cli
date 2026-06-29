# ITPay CLI

Open-source command line client, buyer skill, and agent-readable docs for ItPay agent-native commerce.

This repository is intentionally small. It contains only the public local tooling needed by users and agents:

- `itp` CLI
- npm package metadata
- install scripts
- smoke and local E2E scripts
- ItPay buyer skill prompt
- agent-readable CLI docs graph

It does not contain the closed-source SaaS backend, database files, payment keys, model provider keys, user credentials, or deployment secrets.

## What This CLI Does

`itp` lets a developer or coding agent discover ItPay services, create cart-first checkouts, show QR payments, wait for verified payment, report secure human delivery status, create one-time human account portal links, and read human-approved Vault grants without exposing raw keys or protected content to the agent.

Main flow:

```text
public catalog search -> explain/recommend -> UCP cart -> checkout -> QR payment -> wait verified -> redacted secure delivery status -> optional human account portal link
```

Supported runtime targets:

```text
codex
claude-code
openclaw
```

Default API endpoint:

```text
https://dev.api.itpay.ai
```

Override it for local development, staging, or production:

```bash
export ITPAY_API_BASE=http://127.0.0.1:18080
export ITPAY_CORE_API_BASE=http://127.0.0.1:18080
```

Production release will switch the package default to `https://api.itpay.ai`.

## Repository Layout

```text
.
├── bin/itp                         # Node.js CLI entrypoint
├── skills/itpay-buyer/SKILL.md     # Buyer agent quick-start skill
├── docs/agent/buyer/*.json         # Agent-readable docs graph
├── install.sh                      # Unix user-level installer
├── install.ps1                     # Windows PowerShell installer
├── smoke.sh                        # Local CLI smoke test
├── e2e-local.sh                    # Local backend E2E test
├── package.json                    # npm package metadata
├── README.md                       # This maintenance guide
├── LICENSE                         # MIT
└── .gitignore
```

## Prerequisites

For local development:

```text
Node.js >= 18
npm
curl
git
```

Optional native credential stores:

```text
macOS: security / Keychain
Linux: secret-tool
```

Non-interactive agent hosts such as Codex automatically use file storage to
avoid OS keychain prompts. To force file storage anywhere:

```bash
ITP_CREDENTIAL_STORE=file itp buyer auth status --host <client> --json
```

If native credential storage is unavailable, the CLI falls back to:

```text
~/.itp/credentials.json
```

The fallback file is written with `0600` permissions.

## Human Account Portal Link

After a buyer has completed first-purchase auth and the CLI has a buyer account session, an agent can create a one-time link for the human to view the ItPay account/order portal:

```bash
itp account login-link --host <client> --json
```

The agent should give the returned `login_url` to the human and must not open or scrape it. The portal shows the same redacted order/vault state available through buyer APIs; raw artifact reveal remains a separate human Passkey/WebAuthn flow.

## Install From npm

```bash
npm install -g @itpay/cli
```

Verify all command aliases:

```bash
itp --version
itpay --version
itpay_cli --version
```

Run without installing globally:

```bash
npx @itpay/cli --version
```

## Agent First Step

If you are an AI agent, read the packaged buyer skill before searching,
creating carts, asking the user to pay, or reporting delivery:

```bash
itp skill show --role buyer --json
```

Then load the quickstart docs page:

```bash
itp docs show quickstart --role buyer --json
```

If confused, search the agent docs instead of guessing:

```bash
itp docs search "<question>" --role buyer --json
```

The skill is a quick-start directory and safety boundary. Detailed flow guidance
lives in `itp docs ... --role buyer --json`. Each docs page contains
`next_docs`, so an agent can read one small guide, act, then load the next guide
from the current state.

Before starting a new purchase, agents should inspect recoverable local state:

```bash
itp status --refresh --host <client> --json
```

Every non-doc command needs a client context. Use `--host codex`,
`--host claude-code`, `--host terminal`, or `--host plain-chat`. For OpenClaw
Telegram private/group chat, use `--host telegram --target <inbound_meta.chat_id>`.
If the CLI returns `client_context_required` or `client_target_required`, rerun
the same command with the requested fields.

Humans can use the default account overview:

```bash
itp status
```

```text
Account:  buyer_7xK2mP9vQ4
Linked:   alipay, wechat
Orders:   12
Device:   Codex on MacBook-Pro (active)
```

If an unfinished run exists, continue it:

```bash
itp resume --run-id <run_id> --host <client> --json
```

## Install From This Repo

```bash
git clone <this-repo-url>
cd itpay_cli
npm run check
```

User-level install:

```bash
./install.sh
```

Or use the script directly:

```bash
node ./bin/itp --version
```

## Basic User Flow

The default endpoint is the AWS dev backend. Set API endpoint only when testing
local or another environment:

```bash
export ITPAY_API_BASE=http://127.0.0.1:18080
```

For the current buyer commerce flow, search the catalog, create a cart/checkout,
show the human QR/payment entry, wait for verified payment, and report only
redacted secure delivery status:

```bash
itp buyer catalog search --query 企业工商 --host <client> --json
itp buyer cart create --variant var_itpay_enterprise_fuzzy_search_cny01 --input company_name=阿里 --host <client> --json
itp buyer checkout create --cart <cart_id> --email <buyer_email> --host <client> --json
itp buyer payment wait <payment_intent_id> --timeout 1 --host <client> --json
itp buyer checkout status <checkout_id> --host <client> --json
```

For the one-command buyer helper:

```bash
itp buy var_itpay_enterprise_fuzzy_search_cny01 --email <buyer_email> --input company_name=阿里 --display agent --no-wait-payment --host <client> --json
```

For multi-item cart tests:

```bash
itp buyer cart create --variants var_itpay_enterprise_precise_lookup_cny05,var_itpay_enterprise_fuzzy_search_cny01 --quantities 1,1 --host <client> --json
itp buyer cart show <cart_id> --host <client> --json
itp buyer cart add <cart_id> --variant var_itpay_enterprise_fuzzy_search_cny01 --quantity 1 --host <client> --json
itp buyer cart remove <cart_id> --line <cart_line_item_id> --host <client> --json
```

Payment QR rules:

- Show `local_qr_path` first when the CLI provides it.
- Otherwise render the ItPay-hosted `qr_png_url` / `preferred_qr_url`.
- Use `mobile_wallet_url` only as a human mobile fallback.
- Do not generate your own QR from payment URLs.
- In OpenClaw Telegram, run root `agent_action.command` or `agent_action.argv` before replying; do not simulate buttons in normal prose.
- Telegram native buttons require `presentation.blocks[].type="buttons"` with `text/url/callback_data`.
- For Codex/Claude Code, send root `agent_instruction.markdown` before any next ItPay command.
- If status is `payment_handoff_required`, `next` is the human reply step, not payment wait.
- Treat only `payment_intent.verified` as payment success.

If the human wants the agent to analyze delivered content, the human must reveal
the artifact in the ItPay account portal with Passkey and choose "Give to
Agent". The agent then discovers the approved grant itself:

```bash
itp buyer vault grants list --checkout <checkout_id> --host <client> --json
itp buyer vault grants read <agent_read_grant_id> --host <client> --json
itp buyer vault read --order <order_id> --artifact <vault_artifact_id> --host <client> --json
```

Agents must not ask humans to paste claim links, claim tokens, raw API results,
provider keys, or grant ids into chat.

Order/account/refund commands require a server-verified buyer session, not a
vault grant. If they fail with a buyer session error, run:

```bash
itp status --refresh --host <client> --json
```

Then follow the returned `next.command`.

## Agent Skill And Docs

Installed agents can read the buyer skill and docs graph at any time:

```bash
itp skill show --role buyer --json
itp skill path --role buyer
itp docs list --role buyer --json
itp docs show quickstart --role buyer --json
itp docs search "<question>" --role buyer --json
```

Repository files:

```text
skills/itpay-buyer/SKILL.md
docs/agent/buyer/*.json
```

Agents should use the buyer skill when the user asks to search, buy, pay, or receive an ItPay service.

The skill rules are strict:

- Do not invent payment links.
- Do not ask users to paste API keys, claim links, claim tokens, redeem codes, or raw keys into chat.
- Use `--json` for agent-run commands.
- Use UCP cart-first checkout for CORE-028 buyer tests.
- Treat only `payment_intent.verified` as payment success.
- Report secure delivery as redacted status only.

## Local Backend E2E

When a local ItPay backend is running on `http://localhost:3000`:

```bash
ITPAY_API_BASE=http://localhost:3000 ./e2e-local.sh
```

The E2E script uses a temporary HOME, so it does not touch your real:

```text
~/.itp
~/.codex
```

The script covers the current buyer CLI smoke path and local backend contracts.

## Development Checks

Run before committing:

```bash
npm run check
npm pack --dry-run
```

Expected `npm pack --dry-run` files:

```text
LICENSE
README.md
bin/itp
e2e-local.sh
install.ps1
install.sh
package.json
skills/itpay-buyer/SKILL.md
docs/agent/buyer/*.json
smoke.sh
```

## npm Publish

Check login:

```bash
npm whoami
```

If needed:

```bash
npm login
```

Check package name:

```bash
npm view @itpay/cli name
```

If the package is not published yet, npm returns a not-found error.

Publish:

```bash
npm publish --access public
```

Post-publish install test:

```bash
TMP_PREFIX=$(mktemp -d)
npm install -g --prefix "$TMP_PREFIX" @itpay/cli
"$TMP_PREFIX/bin/itp" --version
"$TMP_PREFIX/bin/itp" skill show --role buyer --json
"$TMP_PREFIX/bin/itp" docs show quickstart --role buyer --json
"$TMP_PREFIX/bin/itpay" --version
"$TMP_PREFIX/bin/itpay_cli" --version
```

## Safety and Secrets

Never commit:

```text
.env
.npmrc with auth token
~/.itp
~/.codex
credentials.json
itpay.env
*.pem
*.key
*.p12
*.pfx
database files
npm tarballs
```

The repository `.gitignore` excludes these by default, including `**/.DS_Store`.

Before pushing or publishing, run:

```bash
git status --short
npm pack --dry-run
npm run check
```

## Maintainer Workflow

Typical update flow:

```bash
git pull
npm run check
# edit bin/itp, skills/itpay-buyer/SKILL.md, or docs/agent/buyer/*.json
npm run check
npm pack --dry-run
git status --short
git add .
git commit -m "Describe the CLI change"
git push
```

For behavior changes, update both:

```text
bin/itp
docs/agent/buyer/*.json
skills/itpay-buyer/SKILL.md
```

If the backend contract changes, update:

```text
README.md
e2e-local.sh
docs/agent/buyer/*.json
skills/itpay-buyer/SKILL.md
```
