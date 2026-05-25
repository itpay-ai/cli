# ITPay CLI

Open-source command line client and agent skill for the VoltaGent / ITPay agent-native model package flow.

This repository is intentionally small. It contains only the public local tooling needed by users and agents:

- `itp` CLI
- npm package metadata
- install scripts
- smoke and local E2E scripts
- VoltaGent agent skill prompt

It does not contain the closed-source SaaS backend, database files, payment keys, model provider keys, user credentials, or deployment secrets.

## What This CLI Does

`itp` lets a developer or coding agent buy and install a VoltaGent model package without manually copying API keys through chat.

Main flow:

```text
register/login -> list plans -> create checkout -> wait payment -> receive grant -> install runtime config -> check balance/usage
```

Supported runtime targets:

```text
codex
claude-code
openclaw
```

Default local API endpoint:

```text
http://localhost:3000
```

Override it for staging or production:

```bash
export VOLTAGENT_API_BASE=https://your-api.example.com
```

## Repository Layout

```text
.
├── bin/itp                         # Node.js CLI entrypoint
├── skills/voltagent/SKILL.md       # Agent skill instructions
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

If native credential storage is unavailable, the CLI falls back to:

```text
~/.itp/credentials.json
```

The fallback file is written with `0600` permissions.

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

If you are an AI agent, read the packaged VoltaGent skill before creating
checkouts, asking the user to pay, installing runtime config, or diagnosing a
grant:

```bash
itp skill show
```

For machine-readable access:

```bash
itp skill show --json
```

To locate the installed skill file:

```bash
itp skill path
```

The skill is the canonical agent runbook for safe payment, credential, install,
and diagnosis behavior. Follow it exactly, especially the rules about `--json`,
`--password-stdin`, verified payment status, and never exposing secrets.

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
checkout, wait for verified payment, install the grant, and write the runtime
config:

```bash
itp setup --plan coding-100 --target codex --method alipay --json
```

With `--no-wait`, setup returns `status=waiting_human_auth` before checkout if
the machine has no valid session, or `status=waiting_human_payment` after
checkout creation when a payment scan is still required.

For local fake-auth/fake-payment testing:

```bash
itp setup --plan coding-100 --target codex --method fake --mock-approve --offline --json
```

Manual flow starts with Alipay-bound agent authentication:

```bash
itp auth register --runtime codex --json
```

The CLI prints the Alipay verification URL and code to stderr, waits for the
scan approval, stores the returned session, and then returns the saved account
metadata as JSON. For local fake-auth testing:

```bash
itp auth register --runtime codex --mock-approve --json
```

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
itp checkout create --plan coding-100 --method alipay --json
```

For local development only, when the backend enables fake payment:

```bash
itp checkout create --plan coding-100 --method fake --idempotency-key manual-test-001 --json
```

Wait for verified payment and grant delivery:

```bash
itp payment wait <checkout_id> --timeout 120 --json
```

Install the grant credential:

```bash
itp grants install <grant_id> --target codex --json
```

Install runtime config:

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

## Agent Skill

Installed agents can read the full skill at any time:

```bash
itp skill show
itp skill show --json
itp skill path
```

Repository skill file:

```text
skills/voltagent/SKILL.md
```

Agents should use the skill when the user asks to buy, recharge, install, configure, diagnose, or check VoltaGent / ITPay model packages.

The skill rules are strict:

- Do not invent payment links.
- Do not ask users to paste API keys into chat.
- Use `--json` for agent-run commands.
- Use `--password-stdin` for passwords.
- Treat only `itp payment wait` returning `grant_issued` as verified delivery.

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
fake checkout
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
"$TMP_PREFIX/bin/itp" skill show --json
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
# edit bin/itp or skills/voltagent/SKILL.md
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
skills/voltagent/SKILL.md
```

If the backend contract changes, update:

```text
README.md
e2e-local.sh
skills/voltagent/SKILL.md
```
