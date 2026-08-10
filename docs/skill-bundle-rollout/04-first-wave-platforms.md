# 当前平台仓库与发布状态注册表

状态：current operational registry。
最后核对：2026-08-10。

本文件是 CLI 文档中平台集合、仓库名称和实际发布状态的唯一权威来源。
不要在 README、bundle 合同或发布手册中维护另一份不同名单。

## 当前注册表

| 产品面 | 仓库 | 默认线路 | 当前形态 | 本轮发布状态 | 最近验收 | 回滚锚点 | 仍需持续验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT + Codex | `itpay-plugin-chatgpt` | ChatGPT MCP；本地 Codex CLI | OpenAI app-plus-skills plugin、MCP config、Skill、离线 CLI | blocked：Buyer Vault 候选尚未完成外部发布 | 2026-08-10 automated CI；ChatGPT/Codex 真机待验收 | pre-Vault `2b1e8a9c8030` | 当前 MCP 合同、OAuth refresh/revoke、OpenAI 审核；本地 CLI bundle pin |
| WorkBuddy | `itpay-skill-workbuddy` | 本地 CLI；显式 MCP | SkillHub/local Skill 包、单文件 CLI、MCP OAuth | blocked：Buyer Vault 候选尚未同步 SkillHub | 2026-08-10 automated CI；WorkBuddy 真机待验收 | pre-Vault `584ebf3f8c46` | 权限模式、窄浏览器、OAuth 回跳/refresh、SkillHub 状态 |
| OpenClaw / ClawHub | `itpay-skill-openclaw` | host-dependent CLI | ClawHub Skill、单文件 CLI | blocked：Buyer Vault 候选尚未同步 ClawHub | 2026-08-10 automated CI；OpenClaw 真机待验收 | pre-Vault `af2aa79d85c8` | 公开目录/审核状态、host renderer、更新/回滚 |
| Kimi Work / Kimi Code | `itpay-plugin-kimi-work` | Work MCP；Code host-dependent CLI | Kimi plugin + Skill、离线 CLI | blocked：Buyer Vault 候选尚未发布；公开 release 仍为 `v2.0.17` | 2026-08-10 automated CI；两个 surface 真机待验收 | `v2.0.17` / `b8d40fe9cffd` | 两个 surface 真机、MCP Token persistence、市场状态 |
| Hermes Agent / Skills Hub | `itpay-skill-hermes` | host-dependent CLI | GitHub Skill tap、单文件 CLI | blocked：Buyer Vault 候选尚未同步 Skills Hub | 2026-08-10 automated CI；Hermes 真机待验收 | pre-Vault `1189f25103fd` | Skills Hub/trusted 状态、更新/回滚、可选 MCP 真机 |

CLI bundle 的实际版本、integrity 和 source SHA 只以各仓库
`bundle.lock.json` 为准，不在本文复制易过期版本号。

`blocked` means the repository candidate must not be presented as externally
published. Update the status, acceptance date, and rollback anchor only after
the named platform has real acceptance and its distribution surface is updated.

## 后续目标，不是当前仓库

| 平台 | 当前状态 | 加入注册表的条件 |
| --- | --- | --- |
| Claude / Claude Code | planned | 确认分发面和仓库，完成 manifest、CLI/MCP 路由、OAuth/Device 真机验收。 |
| Gemini CLI | planned | 确认当前 Extension 规则，完成仓库、manifest、bundle 和真机验收。 |
| 豆包/扣子/火山/其他 | unconfirmed | 明确具体产品面和官方第三方发布入口，不能相互代替。 |

不要创建空仓库占位，也不要根据旧建议名单宣称支持。

## 统一合同

- CLI 唯一真源是精确 npm `@itpay/cli`；
- 平台仓库只保存 manifest、Skill、generated bundle、lock、测试和发布材料；
- 本地使用 Device Authority，远程使用 MCP OAuth Connection；
- 平台原生 MCP client 保管 Token；
- 一个任务只走一条线路，不静默 fallback；
- 不运行时下载 `latest`，不调用全局 CLI，不 patch generated bundle；
- 同步只创建 PR，不自动发布；
- Backend compatibility、CLI npm、平台 bundle 和 MCP contract 分别记录；
- 跨平台 Buyer Vault 功能上线后，公共 MCP 只注册批准的五个工具。

## 每次发布如何更新

五个平台仓库每小时错峰检查 npm `@itpay/cli` 的正式版。发现版本高于各自 `bundle.lock.json` 后，调用 CLI `main` 上的统一 reusable workflow，重建对应格式的 bundle并运行仓库测试。更新 PR 优先由最小权限 `itpay-bundle-sync` GitHub App 创建；仓库未配置 App 时回落到 `GITHUB_TOKEN` 并明确要求人工批准 PR checks。该流程禁止个人 PAT，不会自动合并或发布商店版本，同一个 CLI 版本已有有效 open PR 时不会重复 force-push。

平台 owner 在真实验收后更新对应行或附加 release record，至少记录：

```text
tested_at
platform package/tag
CLI version + npm integrity (local lane)
MCP/Backend revision (remote lane)
positive/negative test result
store/review status
rollback artifact
```

“CLI 已发布”或“Backend 已部署”不能推断平台已更新。

## 历史通用仓库

旧 `itpay-ai/skill` 不再作为 CLI 或平台业务真源。独立仓库迁移完成后，
它只能归档或作为不含 bundle/业务分叉的索引仓库；不能继续手工 patch CLI。
