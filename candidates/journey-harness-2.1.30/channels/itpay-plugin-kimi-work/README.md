# ItPay for Kimi Work and Kimi Code

Kimi plugin containing an ItPay Skill and a pinned, offline single-file `@itpay/cli` bundle.

## Package contract

- Manifest: `kimi.plugin.json` at repository/archive root.
- Skill: `skills/itpay/SKILL.md`.
- Runtime: Node.js 18+ with one bundled `.mjs`; no `node_modules`, global ItPay install, or runtime npm download.
- Kimi Work is built on the Kimi Code local Agent kernel, so this first package uses the existing `kimi-code` ItPay Agent Type.
- The Skill resolves its launcher through `${KIMI_SKILL_DIR}` and the launcher fixes `ITPAY_AGENT_TYPE=kimi-code`, independent of the current working directory.
- Checkout remains an external human handoff; no card data, CVV, payment password, verification code, or wallet private key is collected.

## Install and distribution

Kimi Code accepts a local directory, ZIP URL, or GitHub repository/release URL:

```text
/plugins install https://github.com/itpay-ai/itpay-plugin-kimi-work
/reload
```

The repository URL installs the latest GitHub Release, falling back to the default branch when there is no release. Releases should therefore use a tag matching `kimi.plugin.json.version` and contain a self-contained root manifest.

Kimi Work officially supports local Skill upload and is powered by the Kimi Code kernel, but the public docs do not expose a third-party curated-marketplace submission form. First test local upload/GitHub installation in the current desktop build; do not claim Featured marketplace availability until Moonshot confirms the publisher path.

## Verify

```bash
npm test
```

Then install from the exact GitHub tag, run `/plugins info itpay`, `/reload`, and confirm `/skill:itpay` discovers the bundled launcher and returns `agent_type: kimi-code`.

Official rules: [Kimi Work overview](https://www.kimi.com/en-cn/help/kimi-work/overview), [Kimi Code plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html), [Kimi Code Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html), [Kimi Work Plugin Center](https://www.kimi.com/help/kimi-work/plugin-center).
