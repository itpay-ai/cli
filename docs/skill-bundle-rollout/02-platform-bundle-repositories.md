# 多平台仓库与 CLI Bundle 合同

状态：current。
最后核对：2026-08-10。

## 1. 原则

每个真实发布面可以有独立仓库，但所有仓库消费同一 MCP 和同一
`@itpay/cli`。独立仓库解决 manifest、安装、提示、审核和发布节奏差异，
不制造平台业务 fork。

```text
itpay-ai/compose
  Backend / OAuth / MCP / Web / Buyer / Vault

itpay-ai/cli
  @itpay/cli source / command docs / bundle generator

platform repository
  manifest / platform Skill / exact CLI bundle / tests / submission
```

## 2. 当前仓库注册表

具体发布状态只在
[04-first-wave-platforms.md](./04-first-wave-platforms.md) 维护。

| 产品面 | 仓库 | 本地 CLI | 远程 MCP |
| --- | --- | --- | --- |
| ChatGPT + Codex | `itpay-plugin-chatgpt` | local Codex | ChatGPT/cloud |
| WorkBuddy | `itpay-skill-workbuddy` | default when shell is available | explicit connection |
| OpenClaw | `itpay-skill-openclaw` | supported host-dependent | only after real client acceptance |
| Kimi Work / Kimi Code | `itpay-plugin-kimi-work` | Kimi Code host-dependent | Kimi Work/remote host-dependent |
| Hermes Agent | `itpay-skill-hermes` | supported host-dependent | only after real client acceptance |

Claude 和 Gemini 属于待开始支持目标；没有真实仓库、manifest 和验收前不放入
当前注册表。

## 3. 平台仓库最小内容

```text
platform manifest / connector config
platform-specific SKILL.md
bin or scripts launcher                     # only for local-capable hosts
vendor/itpay-cli/                           # generated, not edited
bundle.lock.json
tests/
README / submission / release notes
```

平台仓库不得包含：

- CLI 源码副本或手工 Agent Type patch；
- Backend/MCP/Vault 状态机；
- OAuth client secret、Access/Refresh Token；
- `.env`、用户 HOME、Device 私钥/session；
- 运行时 `npm install` 或 `latest`；
- 全局 CLI fallback。

## 4. Bundle 格式

优先复用现有已验证格式：

```text
npm-tree
  vendor/itpay-cli/package/
  vendor/itpay-cli/node_modules/       production only

single-file-esm
  vendor/itpay-cli/itpay-cli.bundle.mjs
  vendor/itpay-cli/docs/
  vendor/itpay-cli/licenses/
```

WorkBuddy/OpenClaw/Hermes 等上传型 Skill 优先使用 `single-file-esm`，不包含
`node_modules`。只有真实平台证明 Node runtime 不可用时，才启动 standalone
executable 工作；不提前维护多架构二进制。

## 5. `bundle.lock.json`

至少包含：

```json
{
  "schemaVersion": 1,
  "package": "@itpay/cli",
  "version": "X.Y.Z",
  "format": "single-file-esm",
  "npmIntegrity": "sha512-...",
  "sourceGitSha": "...",
  "generatedAt": "<RFC3339>",
  "node": ">=18",
  "bundleDirectory": "vendor/itpay-cli",
  "dependencyLockSha256": "<64 lowercase hex characters>"
}
```

`format` is `single-file-esm` or `npm-tree`. `bundleDirectory` is the
repository-relative Skill bundle directory, and `dependencyLockSha256` is the
raw lowercase SHA-256 hex digest emitted by `build-platform-bundle.mjs` (without
a `sha256:` prefix). The reusable synchronization workflow consumes these exact
field names.

不得包含 Token、registry credential、本机路径或 Device 状态。

## 6. 启动器规则

- 只调用 bundle 内入口；
- 转发全部参数、stdout、stderr、signal 和 exit code；
- 不修改 `HOME`；
- 不搜索 PATH 中其他 `itpay`；
- `itpay --version` 必须等于 lock version；
- 临时测试使用临时 HOME，不能触碰开发者真实 Device；
- 路径含空格和中文用户名仍可运行。

## 7. 平台 Skill 允许差异

允许：

- manifest 和安装路径；
- MCP 配置语法；
- Agent Type / host 选择；
- 平台工具名和浏览器/文件展示方式；
- 权限说明和审核材料；
- CLI/MCP 路由提示；
- 平台特有的安全限制。

不允许：

- 改变 CLI 命令参数和 JSON 合同；
- 改变 MCP 工具 Schema；
- 改变 Buyer/Vault/支付/退款规则；
- 保存 OAuth Token；
- 自动猜测并切换线路；
- 修改生成的 CLI bundle 业务代码。

## 8. Bundle 生成

生成器只接受精确 semver：

```text
resolve exact npm version
-> fetch tarball metadata
-> verify npm integrity
-> install exact production dependencies with scripts disabled
-> remove cache/test/temp files
-> create requested bundle format
-> generate lock
-> secret/dangerous-file scan
-> offline smoke
```

拒绝 `latest`、范围、未发布版本和 integrity 不匹配。

## 9. CLI 发布后的同步

```text
@itpay/cli X.Y.Z published
-> platform repo detects version drift
-> invoke reusable bundle workflow
-> rebuild and verify
-> update lock/manifest/release notes
-> create or refresh sync PR
-> platform owner reviews tests and Skill differences
-> merge/tag/publish separately
```

CLI 主仓库在 `main` 提供 reusable workflow。各平台仓库每小时错峰运行 caller workflow，并可手动触发；npm `dist-tags.latest` 或请求的 bundle format 与当前 `bundle.lock.json` 不同时更新。同步优先使用只安装到分发仓库、只拥有 Contents/Pull requests 写权限的 `itpay-bundle-sync` GitHub App 短期 token；未配置 App 时回落到平台仓库自己的 `GITHUB_TOKEN`，但该模式创建的 PR checks 需要仓库写权限用户批准。禁止使用个人 PAT。

同步决策同时读取 main 和当前版本的 open automation PR。目标版本、format 和 bundle directory 已存在于 open PR 时必须返回 `pr-current`，不得每小时重建、提交或 force-push 同一产物。

- 优先使用最小权限 GitHub App 短期 token；
- fallback 只使用平台仓库自己的 `GITHUB_TOKEN`；
- 禁止个人 PAT；
- 不自动合并；
- 不自动打 tag；
- 不自动提交商店；
- CLI 发布失败时不生成平台发布。

- 重新生成 bundle；
- 更新 manifest 版本、lock、changelog；
- 跑全套测试；
- 对启用 Skill 差异跟踪的平台，比较旧、新 `sourceGitSha` 的中心 `skills/itpay/SKILL.md`；有差异时创建 Draft PR、附 diff 和人工合并清单，但不覆盖平台 Skill；
- 创建或刷新 `automation/itpay-cli-X.Y.Z` 分支和同步 PR；同版本的后续计划任务必须为 no-op；
- PR 描述列出 CLI commit、integrity、dependency lock、同步 run、平台测试和是否需要商店重新审核；
- 新版本 PR 验证成功后，只关闭没有人工提交的旧机器人同步 PR；保留远程分支用于审计和恢复。

## 10. Repository tests

每个平台必须证明：

- 无全局 CLI；
- 测试期间禁止 npm 网络下载；
- bundle version/integrity/source SHA 正确；
- manifest 能被平台 validator 读取；
- platform Skill 只选择一个 CLI/MCP lane；
- MCP Token 不进入配置、prompt、tool 或 bundle；
- Device 文件不被打包或打印；
- 同机旧全局 CLI 不影响 bundled CLI；
- 升级/回滚不删除 `~/.itpay-v3`；
- 平台声称支持 MCP 时完成真实连接、刷新、重连和撤销测试。

## 11. 版本与回滚

第一阶段平台包版本跟随 CLI 版本，避免双版本映射。只有平台仅修改 manifest/
说明且真实需要独立发布节奏时，才增加 `pluginVersion`，同时保留
`cliVersion`。

回滚发布上一个通过验证的 bundle/manifest，不修改 Buyer、MCP Connection 或
Device 状态。
