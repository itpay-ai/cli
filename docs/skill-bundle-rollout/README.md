# ItPay MCP 认证与多平台 Bundle Skill 落地方案

状态：拟定，等待实施
最后核对：2026-07-21

## 目标

下一阶段只做两个核心任务：

1. 为远程 MCP 建立独立的用户 OAuth 认证通道，同时保留现有 CLI Device Authority，不让两套身份互相覆盖。
2. 为 OpenAI、Claude Code、Gemini CLI、WorkBuddy 分别维护发布仓库；每个 Skill/Plugin 自带固定版本的 CLI bundle，并在 CLI 发布后自动发起同步更新。

具体文件：

- [任务一：MCP 认证系统](./01-mcp-authentication.md)
- [任务二：多平台 Bundle Skill 仓库与同步](./02-platform-bundle-repositories.md)
- [各平台制作、验证和上传手册](./03-platform-publishing.md)

## 已确认的当前状态

当前 CLI 的身份不是网页登录用户，而是本机设备身份：

```text
~/.itpay-v3/device/device-private.pem  Ed25519 私钥，0600
~/.itpay-v3/device/identity.json       Device、Agent Instance、短期 session
```

`src/state/device_authority.ts` 为受保护请求生成：

```text
Authorization: ItPayDevice <session>
X-ItPay-Agent-Instance-ID: <id>
X-ItPay-Agent-Type: <type>
X-ItPay-Agent-Signature: <signature>
```

它适合 Codex CLI、Claude Code、Gemini CLI、WorkBuddy 等本地运行时，但不能作为 ChatGPT 等云端会话的稳定用户身份。CLI 还支持通过 `ITPAY_BEARER_TOKEN` 执行账号范围命令，但目前没有面向 MCP 平台连接的完整 OAuth 生命周期。

## 目标身份模型

```text
本地 Agent
  -> CLI Device Authority
  -> device principal / agent instance
  -> ItPay Backend

云端 Chat 平台
  -> ItPay MCP OAuth
  -> user principal / OAuth client connection
  -> ItPay Backend

两条通道
  -> 可关联到同一 ItPay account
  -> 共用订单、套餐和授权政策
  -> 不共用私钥、session、token 文件或认证 Header
```

`~/.itpay-v3` 只能表示某个本地安装；ItPay 后端的稳定 `user_id` 才表示收费用户。

## 发布仓库建议

以下名称是建议值，创建仓库时可按组织规范调整：

| 平台 | 建议仓库 | 公开形态 |
| --- | --- | --- |
| OpenAI | `itpay-skill-openai` | MCP App + bundled Skill Plugin |
| Claude Code | `itpay-skill-claude-code` | Claude Plugin，含 `skills/`、`bin/`、可选 `.mcp.json` |
| Gemini CLI | `itpay-skill-gemini-cli` | Gemini Extension，含 `gemini-extension.json` 和 `skills/` |
| WorkBuddy | `itpay-skill-workbuddy` | 可上传技能包；公共 SkillHub 发布待平台确认 |

不要把四个平台适配器放回 CLI 主仓库，也不要让平台仓库成为 CLI 源码的第二份手工副本。CLI 主仓库发布 npm 版本；平台仓库只消费一个精确版本并保存可验证的 bundle。

## 执行顺序

1. 完成任务一的 OAuth 最小闭环：登录、回调、刷新、撤销、MCP 鉴权和账号映射。
2. 先建立 Claude Code 和 Gemini CLI 仓库，验证本地 bundle 与现有 Device Authority。
3. 建立 OpenAI 仓库，把同一 Plugin 中的 MCP OAuth 路径和本地 Codex bundle 路径分开。
4. 建立 WorkBuddy 技能包并完成本地上传验证；取得 SkillHub 发布入口后再公开。
5. 在 CLI npm 发布成功后触发四个仓库的同步 PR。
6. 各平台分别审核、发布和回滚，不从 CLI 发布工作流直接绕过平台审核。

## 统一完成标准

- 本地 CLI 升级前后的 Device ID、私钥和 quota lineage 不被 MCP 登录修改。
- MCP token 不能用于 `ItPayDevice` Header；Device session 也不能访问 MCP 用户端点。
- 同一 ItPay 用户可以从不同平台 OAuth 登录，并看到其有权访问的账号范围数据。
- 每个平台包内记录 CLI 版本、npm integrity 和 CLI 源提交。
- bundle 在无全局 `itpay`、无运行时 npm 下载的干净环境中通过 smoke test。
- Skill 不读取或打印 `~/.itpay-v3` 中的私钥、session、Bearer token。
- 支付仍使用外部 Checkout 和人类确认；MCP/Skill 不采集银行卡、CVV、支付密码或钱包私钥。

## 当前不做

- 不建立第二套 ItPay 用户数据库。
- 不把 ChatGPT、Claude 或 Gemini 平台账号 ID 当作 ItPay 主账号。
- 不用 Git submodule、运行时 `npm install -g` 或 `latest` 保持同步。
- 不自动提交或发布未经人工确认的平台商店版本。
- 不承诺 WorkBuddy SkillHub 公共上架，直到取得官方发布入口和审核规则。
