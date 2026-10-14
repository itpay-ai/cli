# ItPay for ChatGPT and Codex

Platform package for the public OpenAI Plugins Directory. It combines an MCP-backed ItPay app for ChatGPT with a bundled CLI Skill for local Codex.

## Package contract

- Required manifest: `.codex-plugin/plugin.json`.
- Skill: `skills/itpay/SKILL.md`.
- Offline CLI: `skills/itpay/vendor/itpay-cli/`, pinned by `bundle.lock.json`.
- ChatGPT uses remote MCP OAuth. It must not treat sandbox files or `~/.itpay-v3` as the user's stable identity.
- Local Codex uses the bundled CLI and a truthful `codex-desktop` or `codex-cli` Agent Type.
- Checkout remains an external human handoff. The plugin never collects card data, CVV, payment passwords, verification codes, or wallet private keys.

## Submission rules

Submit as **With MCP** (app-plus-skills), not Skills only. The publisher needs OpenAI Platform **Apps Management: Write** and a verified developer or business identity. The portal requires a public production MCP URL, domain challenge, OAuth/reviewer access, exact CSP, accurate tool annotations, starter prompts, exactly five positive and three negative test cases, release notes, countries, website, support, privacy, and terms.

The Skills ZIP limit is 100 MB and must contain one plugin root. Public submission scans the MCP server and uploads the final Skill tree separately; it cannot publish a reference to an already-released ChatGPT app.

Current blocker: the public ItPay MCP OAuth server and legal/support URLs are not present in the CLI repository. Keep `.mcp.json` out until those production values exist.

## Verify

```bash
npm test
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
```

Official rules: [Build plugins](https://learn.chatgpt.com/docs/build-plugins), [Submit plugins](https://learn.chatgpt.com/docs/submit-plugins), [Submission errors](https://learn.chatgpt.com/docs/plugin-submission-errors).
