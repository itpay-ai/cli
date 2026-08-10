# 各平台制作、验证、发布与回滚手册

状态：current operational handbook。
最后核对：2026-08-10。

平台规则会变化。每次正式提交前必须重新核对平台官方要求；本文只固定 ItPay
自己的安全、版本和职责边界。

## 1. 共用发布前门禁

- 平台存在于 [04-first-wave-platforms.md](./04-first-wave-platforms.md)；
- manifest/Skill/MCP config 来自平台仓库，不来自 Compose 或 CLI 临时目录；
- CLI bundle 绑定精确 npm version、integrity、source SHA；
- 无全局 CLI、无运行时 npm、离线 smoke 通过；
- Skill 披露网络、命令、文件和外部 ItPay 授权页面；
- MCP OAuth Token 由平台原生客户端保管，模型/Skill/CLI 看不到；
- Local 使用 Device Authority，Remote 使用 MCP Connection；
- 一个任务只选一条线路，不静默 fallback；
- 公共 MCP `tools/list` 与当前批准合同一致；
- Buyer Vault 读取只返回授权字段；
- 支付/退款不因 OAuth、Skill 安装或 Vault 读取获得授权；
- `.env`、Secret、Token、私钥、Device 文件、用户数据未打包；
- website、support、privacy、terms、数据删除/断开说明可访问；
- 正向、负向、越权、撤销、刷新和回滚测试完成。

## 2. ChatGPT + Codex

仓库：`itpay-plugin-chatgpt`。

### ChatGPT 云端

- 只走远程 MCP OAuth；
- 平台原生保存/刷新 Token；
- 使用批准的五个 Buyer Vault read/authorization 工具；
- 不探测本地 HOME 或创建 Device；
- tool annotations、CSP、OAuth metadata、domain challenge 和审核材料在
  OpenAI 平台仓库维护；
- 审核账号只含固定测试数据，不要求真实付款。

### 本地 Codex

- 有 bundled CLI 时默认 Local Device；
- Skill 使用 bundle 的确定入口，不调用全局 CLI；
- 用户明确要求 MCP 才选择远程 MCP；
- ChatGPT/Codex 共用发布仓库不代表共用凭据或运行路径。

验证：ChatGPT OAuth connect/refresh/revoke/Vault read；Codex fresh install、
Device persistence、CLI Vault read、同机旧全局 CLI 隔离。

## 3. WorkBuddy

仓库：`itpay-skill-workbuddy`。

- 有持久 Shell 和 Skill bundle 时默认 CLI；
- 用户明确连接/要求 MCP 时使用 WorkBuddy 原生 MCP OAuth；
- CLI 持久写 `~/.itpay-v3` 前遵循 WorkBuddy 权限模型；
- Checkout/Auth handoff 只使用官方 HTTPS URL/Action Card 和平台实际打开
  工具；
- 不读取任意目录，不下载/rebuild QR，不处理用户 Device lock；
- MCP Access Token 到期必须静默 refresh；Vault window 到期只重新授权
  Vault；
- 上传包使用 `single-file-esm`，不含 `node_modules`。

验证：默认权限、用户拒绝权限、完全访问权限、路径空格/中文、窄内置浏览器、
MCP 首次连接、扫码/回跳、refresh、关闭面板重连、Vault expiry/revoke。

SkillHub 上传/审核由仓库管理员执行；在官方确认前不宣称公共收录状态。

## 4. OpenClaw

仓库：`itpay-skill-openclaw`。

- 本地持久 host 使用 single-file CLI bundle；
- 每次需要 native presentation 的命令显式传可信 `--host` 和目标上下文；
- Telegram/Discord 等 host renderer 只负责展示，不改变业务合同；
- 只有平台的远程 MCP OAuth 通过真实验收后才启用 MCP lane；
- ClawHub 发布版本必须和 lock/Skill metadata 一致。

验证：无全局 CLI、host/target、原生按钮/普通内容 fallback、Device 持久化、
bundle 更新/回滚、若启用 MCP则连接/refresh/revoke。

## 5. Kimi Work / Kimi Code

仓库：`itpay-plugin-kimi-work`。

- Kimi Work 纯云端环境优先 MCP；
- Kimi Code 有持久 Shell 和 bundle 时默认 CLI；
- manifest/Skill 必须显式区分两个 surface；
- extension/plugin setting 不存 OAuth Token；
- 只有实际客户端证明的 token persistence/refresh 行为写入支持矩阵。

验证：两个 surface 分别全新安装、线路选择、升级、Token refresh、Device 文件
隔离和 Vault 跨平台读取。

## 6. Hermes Agent

仓库：`itpay-skill-hermes`。

- 本地 Skill tap 使用 single-file CLI bundle；
- 不调用全局 CLI或 runtime npm；
- Skills Hub/trusted 状态按真实上游结果记录；
- 远程 MCP 仅在 Hermes 客户端完成标准 OAuth 实测后启用。

验证：tap 安装/更新/回滚、无网 bundle、Device persistence、命令输出合同、若
启用 MCP则连接/refresh/revoke。

## 7. 后续平台

Claude 和 Gemini 不在当前仓库注册表。开始真实工作时才：

1. 核对当前官方 manifest/connector/auth 规则；
2. 确认真实分发面和仓库名；
3. 建平台仓库；
4. 选择 CLI/MCP lane；
5. 完成真实安装和 Token/Device 测试；
6. 加入注册表和发布矩阵。

不能根据旧文档中的“建议仓库”直接宣称已支持。

## 8. 发布顺序

```text
Backend/MCP/Web contract accepted on Dev
-> CLI docs and implementation accepted
-> exact npm CLI published
-> platform sync PRs generated
-> each platform runs its own E2E/review
-> platform merge/tag/store submission
-> update actual version/status registry
```

如果仅远程 MCP 变化且平台 manifest/Skill 不变，平台仍需运行 connector E2E，
但不为了形式强制发布新 CLI bundle。

## 9. 回滚

- Backend/MCP/Web 使用 Compose release rollback，不改变平台 Token/Device；
- CLI 回滚发布上一个验证 bundle；
- 平台回滚使用上一个 tag/artifact；
- 不删除 `~/.itpay-v3`；
- 不撤销所有 MCP Connection，除非安全事件明确要求；
- 工具合同回滚后重新验证平台 `tools/list` 与 Backend compatibility；
- 记录原因、版本、时间、影响平台和恢复证据。

## 10. 实际发布矩阵

矩阵不写死在本文，统一维护在
[04-first-wave-platforms.md](./04-first-wave-platforms.md)。

每行至少记录：

```text
product surface
repository
supported lane
CLI bundle version/integrity (if local)
MCP contract/revision tested (if remote)
draft/review/published/blocked
last real acceptance date
rollback artifact/tag
```
