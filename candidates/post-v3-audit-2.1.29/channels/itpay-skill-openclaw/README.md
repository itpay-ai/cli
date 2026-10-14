# ItPay for OpenClaw and ClawHub

Portable OpenClaw Skill with a pinned, offline `@itpay/cli` bundle.

## Package contract

- Publish the folder `skills/itpay/`.
- `SKILL.md` declares Node.js as the only host binary requirement.
- Total artifact size must stay below ClawHub's 50 MB limit.
- Agent Type: `openclaw` for the whole flow.
- OpenClaw has no default entry: the Skill passes the current Host explicitly. Telegram receives a native `message` action; other channels receive the standard HTTPS QR and Checkout link.
- The Skill never downloads `latest`, hides commands, asks for private keys, or approves payment on the user's behalf.
- ClawHub Skills are MIT-0; bundled ItPay CLI and dependency license notices remain separately included under `vendor/itpay-cli/`.
- ClawHub has no paid-Skill or revenue-share metadata. ItPay prices are external service costs and must be shown before Checkout.

## Publish

```bash
clawhub login
VERSION="$(node -p 'require("./package.json").version')"
clawhub skill publish ./skills/itpay --slug itpay --name "ItPay" --owner itpay --version "$VERSION"
```

The Skill is owned by the `@itpay` ClawHub publisher. New releases are validated and may remain hidden until automated security review completes. For CI, use ClawHub's reusable `skill-publish.yml`; start with `dry_run: true`.

## Verify

```bash
npm test
VERSION="$(node -p 'require("./package.json").version')"
clawhub skill publish ./skills/itpay --slug itpay --name "ItPay" --owner <itpay-owner> --version "$VERSION" --dry-run
```

Official rules: [Publishing](https://docs.openclaw.ai/clawhub/publishing), [Skill format](https://docs.openclaw.ai/clawhub/skill-format), [Authentication](https://docs.openclaw.ai/clawhub/auth), [Acceptable usage](https://docs.openclaw.ai/clawhub/acceptable-usage), [Security audits](https://docs.openclaw.ai/clawhub/security-audits).
