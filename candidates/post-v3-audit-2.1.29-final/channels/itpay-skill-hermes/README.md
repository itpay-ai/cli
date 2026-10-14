# ItPay for Hermes Agent

Hermes Skills Hub package with a pinned, offline single-file `@itpay/cli` bundle.

## Install

Install this public GitHub Skill directly:

```bash
hermes skills inspect https://raw.githubusercontent.com/itpay-ai/itpay-skill-hermes/main/skills/itpay/SKILL.md
hermes skills install https://raw.githubusercontent.com/itpay-ai/itpay-skill-hermes/main/skills/itpay/SKILL.md
```

Or subscribe to the ItPay repository as a tap:

```bash
hermes skills tap add itpay-ai/itpay-skill-hermes
hermes skills install itpay-ai/itpay-skill-hermes/skills/itpay
```

Then start a fresh Hermes session and run:

```text
/itpay find a verified service for my request
```

## Package contract

- Node.js 18+ is the only runtime requirement.
- The Skill contains one ESM CLI bundle and no `node_modules`.
- `${HERMES_SKILL_DIR}` resolves every bundled path.
- The launcher fixes the ItPay Agent Type to `hermes`.
- Checkout is an external human handoff; payment secrets are never collected in chat.
- `hermes skills check` and `hermes skills update itpay` retrieve later GitHub versions.

Every published `@itpay/cli` version is rebuilt by the shared CLI workflow. If the center Skill changed, the update PR remains draft until Hermes-specific guidance is reviewed.

Official format: [Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills) and [Skills Hub](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
