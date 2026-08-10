# ItPay 平台 Skill / Plugin 与 CLI Bundle 文档入口

状态：current。
Authority：CLI 与平台发布边界入口。
最后核对：2026-08-10。

本目录只管理 CLI 和平台发布合同，不管理 Backend、OAuth Server、Buyer、
Vault 或授权状态机。

跨平台 Buyer Vault 读取的权威开发计划在 `itpay-ai/compose`：

```text
docs/v3/V3_CROSS_PLATFORM_BUYER_VAULT_READ_IMPLEMENTATION_PLAN.md
```

远程 MCP OAuth 与 Local Device Authority 的权威实现记录在：

```text
docs/v3/V3_MCP_OAUTH_AND_LOCAL_DEVICE_AUTH_IMPLEMENTATION_PLAN.md
```

## 文档路由

| 文件 | 负责内容 |
| --- | --- |
| [01-mcp-authentication.md](./01-mcp-authentication.md) | CLI Device 与远程 MCP OAuth 的边界、Token 保管、CLI/MCP 路由。 |
| [02-platform-bundle-repositories.md](./02-platform-bundle-repositories.md) | 平台独立仓库、bundle、lock、同步 PR 和禁止复制核心代码。 |
| [03-platform-publishing.md](./03-platform-publishing.md) | 平台制作、验证、发布、回滚的通用手册和平台差异。 |
| [04-first-wave-platforms.md](./04-first-wave-platforms.md) | 当前真实平台仓库注册表和发布状态；平台集合只以此文件为准。 |
| [05-sync-operations.md](./05-sync-operations.md) | Bundle 同步 GitHub App、fallback、幂等、事故处理和人工恢复。 |

## 当前身份边界

```text
本地 Agent
-> bundled @itpay/cli
-> ~/.itpay-v3 Device Authority
-> exact Agent Instance
-> ItPay Backend

云端 Chat 平台
-> 原生 MCP OAuth
-> exact MCP Connection
-> ItPay MCP
-> short workload delegation
-> ItPay Backend
```

两条通道可以关联同一 Buyer 并读取同一 Buyer Vault，但不共享：

- Device 私钥或 Device Session；
- OAuth Access/Refresh Token；
- Agent Instance 或 MCP Connection；
- 临时 Vault 授权窗口；
- 工件首次揭示授权。

## 仓库职责

### CLI 仓库

负责：

- `@itpay/cli` 源码；
- Device Authority；
- 命令、参数和标准输出；
- 通用 Agent Type/host renderer；
- bundle 生成与可复现性合同；
- CLI 命令文档和测试。

不负责：

- MCP OAuth Token 保存；
- Buyer/Vault 业务状态机；
- 平台商店 manifest；
- 平台专属业务逻辑。

### 平台仓库

只负责：

```text
manifest / MCP config
平台专属 Skill 与 CLI/MCP 路由
精确 CLI bundle（本地平台）
bundle.lock.json
平台测试、审核和发布材料
```

不复制 CLI 源码，不实现 OAuth/Vault/支付，不在运行时下载 `latest`。

## 当前平台集合

当前发布面只以
[04-first-wave-platforms.md](./04-first-wave-platforms.md) 为准：

- ChatGPT + Codex；
- WorkBuddy；
- OpenClaw；
- Kimi Work / Kimi Code；
- Hermes Agent。

Claude 与 Gemini 是后续支持目标，不在没有真实实现和验收时创建占位仓库或
写成“首批已实施”。

## 一个任务只走一条线路

```text
有持久本地 Shell + bundled CLI + 用户未指定 MCP -> CLI
纯云端平台 -> MCP
用户明确指定 MCP -> MCP
用户明确指定 CLI -> CLI
```

选定后禁止静默 fallback。Device 被吊销不能自动改走 MCP；MCP OAuth 失败
不能自动创建本地 Device。

## CLI 文档先行

任何命令变更必须遵守：

```text
先更新 command reference
-> 冻结参数/状态/JSON/instruction/next/recovery
-> 再改代码
-> 自动测试
-> 构建真实 CLI
-> 临时 HOME + 真实 Backend 执行
-> 实际输出逐字段对照文档
```

JSON 模式 stdout 只能有一个标准 envelope；不能追加调试、进度或提示文本。

## 统一发布门禁

- npm 精确版本、integrity、source SHA 可验证；
- 平台 bundle 版本等于 `bundle.lock.json`；
- 无全局 CLI、无运行时 npm、离线 smoke 通过；
- Skill/bundle 不含 `.env`、Token、私钥、Device 文件或用户数据；
- 平台原生客户端保管和刷新 OAuth Token；Skill/CLI/模型看不到 Token；
- 同步只开 PR，不自动合并、打 tag 或发布商店；
- 每个平台分别保存实际已发布版本和回滚版本；
- Backend compatibility 返回精确最低 CLI 版本，不指导盲目安装 `latest`。

## 当前不做

- 不为每个平台部署一套 MCP Backend；
- 不建立第二套 Buyer 数据；
- 不把平台账号 ID 当 ItPay Buyer；
- 不为不兼容 OAuth 的平台发明模型可见固定 Token；
- 不为尚未开始的平台创建空仓库；
- 不在这个 CLI 文档目录重复服务端 Schema/API/Owner 设计。
