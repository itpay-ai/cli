# 首批平台执行状态（2026-07-22）

首批按真实发布面拆成四个可落地仓库；豆包单独列为阻塞，不创建占位仓库。

| 产品面 | 仓库 | 形态 | 当前可做 | 外部阻塞 |
| --- | --- | --- | --- | --- |
| ChatGPT + Codex | `itpay-plugin-chatgpt` | OpenAI app-plus-skills plugin | `.codex-plugin/plugin.json`、Skill、离线 CLI、审核测试 | production MCP OAuth、域名 challenge、发布身份、legal/support URLs |
| WorkBuddy | `itpay-skill-workbuddy` | SkillHub Skill 包 | `SKILL.md`、离线 CLI、权限/数据披露、ZIP | SkillHub 账号内上传由仓库管理员完成 |
| OpenClaw / ClawHub | `itpay-skill-openclaw` | `@itpay/itpay@2.0.17` ClawHub Skill | 已发布单文件 CLI bundle | 首次安全审核与公开目录收录 |
| Kimi Work / Kimi Code | `itpay-plugin-kimi-work` | `kimi.plugin.json` plugin + Skill | GitHub/Release 安装包、离线 CLI | Kimi Featured/第三方市场提交通道未公开；需桌面版实测 |
| Hermes Agent / Skills Hub | `itpay-skill-hermes` | GitHub Skill tap | Hermes 专属 Skill、单文件 CLI bundle、自动更新 | Skills Hub 全局默认索引与 trusted 等级需上游收录 |
| 豆包 | 暂不建仓 | 无可验证的 Skill bundle 发布面 | 保留调研记录 | 公开报道指向 2026-07-15 下线；需确认是否改为扣子、火山方舟 MCP 市场或 TRAE |

## 统一合同

- CLI 唯一真源是 npm `@itpay/cli` 的精确版本。
- 平台仓库只存 manifest、平台 Skill、离线 vendor、`bundle.lock.json`、测试和提交材料。
- bundle 生成器记录 npm integrity、npm `gitHead`、Node 要求和 production dependency lock hash。
- 本地 Agent 使用 Device Authority；ChatGPT 云端使用远程 MCP OAuth，两者不共享凭据。
- 不在运行时安装 `latest`，不回退到全局 CLI，不复制 CLI 源码继续分叉开发。

## CLI 更新机制

四个平台仓库每小时错峰检查 npm `@itpay/cli` 的正式版。发现版本高于各自 `bundle.lock.json` 后，调用 CLI `main` 上的统一 reusable workflow，重建对应格式的 bundle、运行仓库测试，并以平台仓库自己的 `GITHUB_TOKEN` 创建更新 PR。该流程不需要 PAT，也不会自动合并或发布商店版本。

## 已发现的现有资产

`itpay-ai/skill` 是旧的多平台通用仓库，固定 CLI 2.0.11，并对 bundle 做过平台 Agent Type patch。首批独立仓库只复用其已验证的 wrapper/test 思路，不再手工 patch CLI。旧仓库在迁移完成前保留，之后再决定归档或改为索引仓库。

## 豆包判断

截至 2026-07-22，没有找到豆包官方的 `SKILL.md + 可执行 bundle` 上传或商店提交流程。公开报道显示豆包智能体功能已于 2026-07-15 下线。扣子、火山方舟 MCP 市场和 TRAE 是不同产品面，不能未经确认就用它们代替“豆包上架”。
