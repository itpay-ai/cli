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

`itp` lets a developer or coding agent discover ItPay services, create cart-first checkouts, show QR payments, wait for verified payment, report secure human delivery status, and create one-time human account portal links without exposing raw keys or protected content to the agent. Legacy VoltaGent model-package setup remains available.

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

Default legacy API endpoint:

```text
http://localhost:3000
```

Override it for ItPay staging or production:

```bash
export ITPAY_API_BASE=https://your-itpay-core.example.com
export ITPAY_CORE_BASE_URL=https://your-itpay-core.example.com
export VOLTAGENT_API_BASE=https://your-api.example.com
```

## Repository Layout

```text
.
├── bin/itp                         # Node.js CLI entrypoint
├── skills/itpay-buyer/SKILL.md     # Buyer agent quick-start skill
├── skills/voltagent/SKILL.md       # Legacy VoltaGent compatibility skill
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
ITP_CREDENTIAL_STORE=file itp setup --credits 100 --method alipay --json
```

If native credential storage is unavailable, the CLI falls back to:

```text
~/.itp/credentials.json
```

The fallback file is written with `0600` permissions.

## Human Account Portal Link

After a buyer has completed first-purchase auth and the CLI has a buyer account session, an agent can create a one-time link for the human to view the ItPay account/order portal:

```bash
itp account login-link --json
```

The agent should give the returned `login_url` to the human and must not open or scrape it. The portal shows the same redacted order/vault state available through buyer APIs; raw artifact reveal remains a separate human Passkey/WebAuthn flow.

## Install From npm

After publishing:

```bash
npm install -g itpay_cli
```

Verify all command aliases:

```bash
itp --version
itpay --version
itpay_cli --version
```

Run without installing globally:

```bash
npx itpay_cli --version
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
itp status --json
```

If an unfinished run exists, continue it:

```bash
itp resume --run-id <run_id> --json
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

Set API endpoint if not using local backend:

```bash
export VOLTAGENT_API_BASE=https://your-api.example.com
```

For the agent-native one-command flow, let the CLI authenticate, create the
checkout, wait for verified payment, and deliver the grant/API credential to
the local `itp` credential store:

```bash
itp setup --credits 100 --method alipay --json
```

This returns `status=grant_ready` with `base_url`, `openai_base_url`, and the
local token helper command. It does not write Codex, Claude Code, or OpenClaw
config by default.

Runtime config writing is opt-in:

```bash
itp setup --credits 100 --target codex --method alipay --install-runtime --json
```

With `--no-wait`, setup returns `status=waiting_human_auth` before checkout if
the machine has no valid session, or `status=waiting_human_payment` after
checkout creation when a payment scan is still required.

QR display is automatic in terminals and machine-readable for chat agents:

```bash
itp setup --credits 100 --method alipay --display auto --json
ITP_HOST=discord itp setup --credits 100 --method alipay --display json --json
ITP_HOST=telegram itp setup --credits 100 --method alipay --display json --json
ITP_HOST=whatsapp itp setup --credits 100 --method alipay --display json --json
```

When interrupted, recover without creating a duplicate checkout:

```bash
itp status --refresh --json
itp resume --json
```

Local and sandbox payment tests use real Alipay sandbox credentials and
`--method alipay`. Fake/mock/offline flows are developer-only simulation hooks
and are intentionally omitted from the normal user flow.

For the ItPay sandbox buyer flow, agents should use the public buyer commands:

```bash
itp buyer catalog search --query "吃鸡 情侣皮肤" --json
itp buyer cart create --variant var_pubg_couple_skin_cny20 --json
itp buyer cart create --variants var_itpay_enterprise_precise_lookup_cny05,var_itpay_enterprise_fuzzy_search_cny01 --quantities 1,1 --json
itp buyer cart show <cart_id> --json
itp buyer cart add <cart_id> --variant var_itpay_enterprise_fuzzy_search_cny01 --quantity 1 --json
itp buyer cart remove <cart_id> --line <cart_line_item_id> --json
itp buyer checkout create --cart <cart_id> --email buyer@example.com --phone +8613800000000 --json
itp buy var_pubg_couple_skin_cny20 --sandbox --email buyer@example.com --phone +8613800000000 --no-wait --json
itp buyer payment wait <payment_intent_id> --json
itp buyer checkout status <checkout_id> --json
```

Alipay sandbox responses expose a stable `payment_entry_url` for browser/status
fallback and a tokenized `qr_image_url` for the human scanner. Render or download
`qr_image_url`; do not turn `payment_entry_url` into a QR code. If the Alipay
sandbox app reports "order not found", ask the API for a fresh display QR:

```bash
itp buyer payment refresh-qr <payment_intent_id> --reason order-not-found --json
```

`wait.timeout` from `/events/wait` is one long-poll cycle timing out, not a
payment failure. The CLI heartbeat reports this as `still_waiting` and continues
until the overall command timeout or a verified payment event. Ops-only sandbox
commands such as `itp ops sandbox worker run-once --json` require the sandbox ops
token and are not part of normal buyer/agent authority.

Live checkpoint on 2026-06-08: `itp buy ... --no-wait --json` created an Alipay
sandbox payment intent, the human scanned the `qr_image_url` SVG directly with
the Alipay sandbox app, public notify reached `/v1/alipay/sandbox/notify`, and
`itp buyer payment wait` returned `payment_intent.verified` without query
recovery.

Manual flow starts with Alipay-bound agent authentication:

```bash
itp auth register --runtime codex --json
```

The CLI prints the Alipay verification URL and code to stderr, waits for the
scan approval, stores the returned session, and then returns the saved account
metadata as JSON.

The response includes the actual saved `username`. Keep it if you plan to log in
later with a password.

Set the first Web login password:

```bash
printf 'your-password\n' | itp account set-password --password-stdin --json
```

Check auth and account state:

```bash
itp auth status --json
itp account show --json
```

List available plans:

```bash
itp plans --json
```

Create a checkout:

```bash
itp checkout create --credits 100 --method alipay --json
```

Wait for verified payment and grant delivery:

```bash
itp payment wait <checkout_id> --timeout 120 --json
```

Install the grant credential:

```bash
itp grants install <grant_id> --target codex --json
```

Optionally install runtime config:

```bash
itp install codex --grant <grant_id> --json
```

For local no-network config writing:

```bash
itp install codex --grant <grant_id> --offline --no-test --json
```

Check balance, usage, and orders:

```bash
itp balance --json
itp usage --grant <grant_id> --json
itp checkout list --limit 20 --json
```

Rotate or revoke a grant:

```bash
itp keys rotate --grant <grant_id> --json
itp grants revoke <grant_id> --json
```

## Runtime Notes

### Codex

The CLI writes:

```text
~/.codex/config.toml
~/.itp/voltagent.env
```

Codex reads `VOLTAGENT_API_KEY` from the process environment. If your launcher does not load the env file automatically, source it before starting Codex:

```bash
source ~/.itp/voltagent.env
```

### Claude Code

The CLI writes the configured Anthropic-compatible base URL and credential through the target profile.

### OpenClaw

The CLI supports `openclaw` as an install target. Use:

```bash
itp grants install <grant_id> --target openclaw --json
itp install openclaw --grant <grant_id> --json
```

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
skills/voltagent/SKILL.md
docs/agent/buyer/*.json
```

Agents should use the buyer skill when the user asks to search, buy, pay, or receive an ItPay service. Use the legacy VoltaGent skill only for the older model-package setup flow:

```bash
itp skill show --role voltagent --json
```

The skill rules are strict:

- Do not invent payment links.
- Do not ask users to paste API keys, claim links, claim tokens, redeem codes, or raw keys into chat.
- Use `--json` for agent-run commands.
- Use UCP cart-first checkout for CORE-028 buyer tests.
- Treat only `payment_intent.verified` as payment success.
- Report secure delivery as redacted status only.

## Local Backend E2E

When a local VoltaGent backend is running on `http://localhost:3000`:

```bash
VOLTAGENT_API_BASE=http://localhost:3000 ./e2e-local.sh
```

The E2E script uses a temporary HOME, so it does not touch your real:

```text
~/.itp
~/.codex
```

The script covers:

```text
server health
plans
auth register
account password setup
Alipay checkout
payment wait
grant install
codex offline install
balance
checkout list
usage
key rotation
token issue
grant revoke
```

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
skills/voltagent/SKILL.md
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
npm view itpay_cli name
```

If the package is not published yet, npm returns a not-found error.

Publish:

```bash
npm publish
```

For a scoped package:

```bash
npm publish --access public
```

Post-publish install test:

```bash
TMP_PREFIX=$(mktemp -d)
npm install -g --prefix "$TMP_PREFIX" itpay_cli
"$TMP_PREFIX/bin/itp" --version
"$TMP_PREFIX/bin/itp" skill show --role buyer --json
"$TMP_PREFIX/bin/itp" docs show quickstart --role buyer --json
"$TMP_PREFIX/bin/itpay" --version
"$TMP_PREFIX/bin/itpay_cli" --version
```

## Backend Contract

The CLI expects a VoltaGent-compatible backend that exposes:

```text
GET  /api/status
GET  /api/itp/plans
POST /api/itp/auth/register
POST /api/itp/auth/login
POST /api/itp/auth/device/start
POST /api/itp/auth/device/:auth_id/poll
GET  /api/itp/auth/status
GET  /api/itp/account
POST /api/itp/account/password
POST /api/itp/checkout
GET  /api/itp/checkout/:id
POST /api/itp/payments/alipay/notify
GET  /api/itp/orders
GET  /api/itp/balance
GET  /api/itp/usage
GET  /api/itp/grants
POST /api/itp/grants/:id/install
POST /api/itp/grants/:id/install-ack
POST /api/itp/grants/:id/rotate
POST /api/itp/grants/:id/revoke
```

Relay base URLs returned by the backend:

```text
/openai/v1
/anthropic/v1
/gemini/v1beta
```

## Safety and Secrets

Never commit:

```text
.env
.npmrc with auth token
~/.itp
~/.codex
credentials.json
voltagent.env
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
# edit bin/itp, skills/itpay-buyer/SKILL.md, docs/agent/buyer/*.json, or skills/voltagent/SKILL.md
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
skills/voltagent/SKILL.md
```

If the backend contract changes, update:

```text
README.md
e2e-local.sh
docs/agent/buyer/*.json
skills/itpay-buyer/SKILL.md
skills/voltagent/SKILL.md
```
