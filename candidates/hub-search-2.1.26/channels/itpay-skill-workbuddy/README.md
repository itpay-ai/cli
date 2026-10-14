# ItPay for WorkBuddy

WorkBuddy Skill package with a pinned, offline `@itpay/cli` bundle.

## Package contract

- Uploadable Skill root: the repository root.
- Required entry: `SKILL.md` at the repository root.
- Runtime: Node.js 18+ with a single-file CLI bundle; no `node_modules`, global ItPay install, or runtime npm download.
- Agent Type: `workbuddy` for the whole flow.
- Commands that persist `~/.itpay-v3` use the host's ordinary persistent-file permission; denial is reported without removing identity.
- Network scope is limited to the official ItPay Backend. Checkout is displayed for human completion; sensitive payment credentials never enter chat or CLI arguments.

## Distribution rules

WorkBuddy publicly documents local package upload: **Skills → Add Skill → Upload Skill**. Installation performs security checks, and users should be shown local command, file, network, third-party data, and financial-operation disclosures.

WorkBuddy also exposes SkillHub and enterprise self-built Skills, but no public community publisher schema or submission API is documented. First ship and test the local package; do not claim a public SkillHub listing until Tencent provides the publisher route.

## Verify and upload

```bash
npm test
zip -qr itpay-workbuddy.zip SKILL.md agents scripts vendor bundle.lock.json
```

Test on macOS and Windows with no global `itpay`, a path containing spaces, a Chinese OS username, default permission prompts, and a temporary HOME for non-production smoke checks.

Official rules: [WorkBuddy Skills](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market), [Permission modes](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes), [Changelog](https://www.workbuddy.cn/docs/workbuddy/Changelog).
