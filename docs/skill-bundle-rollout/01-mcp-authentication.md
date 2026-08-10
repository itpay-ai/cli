# Local Device 与远程 MCP OAuth 边界

状态：current boundary；服务端实现以 `itpay-ai/compose` 为准。
最后核对：2026-08-10。

## 1. 本文负责什么

本文只定义 CLI/平台包必须遵守的身份选择和凭据保管规则。

服务端 OAuth 协议、Connection、workload delegation、Buyer 和 Vault 数据
模型由 Compose 仓库的 V3 文档、Schema、OpenAPI 和代码负责。CLI 仓库不再
维护一份重复的 OAuth Server 实施计划。

## 2. Local Device Authority

本地 CLI 使用：

```text
~/.itpay-v3/device/device-private.pem
~/.itpay-v3/device/identity.json
```

`src/state/device_authority.ts`：

- 生成/保存本地 Ed25519 私钥；
- 按 Backend base URL 保持独立 Device registration；
- 按显式 Agent Type 解析 exact Agent Instance；
- 用 challenge 签名取得短期 Device Session；
- 对受保护请求签名并防重放；
- 只对可恢复 session 执行一次续期和同请求重放；
- 不静默替换被吊销 Device。

这些文件表示本地工作负载，不表示网页登录 Token，也不能被复制进平台
bundle。

## 3. 远程 MCP OAuth

云端 MCP 客户端使用标准 OAuth Connection：

```text
MCP client
-> Authorization Code + PKCE
-> ItPay login/consent
-> client stores Access/Refresh Token
-> ItPay MCP validates token
-> exact MCP Connection
-> Buyer-less workload delegation to Backend
```

平台客户端负责 Token 持久化、刷新和断线重连。以下位置都不能保存或打印
OAuth Token：

- CLI；
- `~/.itpay-v3`；
- Skill / Plugin；
- `bundle.lock.json`；
- 模型提示、tool 参数或 tool 输出；
- Git 仓库；
- Backend 普通 API 日志。

十分钟 Access Token 到期应由 Refresh Token 自动续期，不得让用户每十分钟
重新扫码。Vault 短期授权到期是独立事件，只重新请求 Vault 授权。

## 4. 两条线路不能混用

| 属性 | Local CLI | Remote MCP |
| --- | --- | --- |
| caller | Device + exact Agent Instance | exact MCP Connection |
| credential owner | 用户本机 CLI | MCP client/platform |
| Authorization | `ItPayDevice` + signed headers | OAuth Bearer at MCP resource |
| server hop | CLI -> Backend | Platform -> MCP -> delegated Backend |
| durable revoke | Device/Agent | Connection/Grant |
| Buyer relationship | explicit Device binding | OAuth Connection binding |

互斥规则：

- Backend Device middleware 不接受 MCP Bearer；
- MCP resource 不接受 Device Session；
- CLI 不读取 MCP Token；
- MCP 不读取 `~/.itpay-v3`；
- 撤销一个通道不删除另一个通道；
- 两个通道可指向同一 Buyer，但 Vault 临时授权按 exact audience 分开。

## 5. 平台路由

平台 Skill 在开始业务动作前选择线路：

```text
persistent local shell and bundled CLI and no explicit MCP -> CLI
pure cloud -> MCP
explicit MCP request -> MCP
explicit CLI request -> CLI
```

同一任务不能：

- 同时调用两条线路；
- 在失败后静默 fallback；
- 用 email、昵称、Agent Type 或平台名推断 Buyer；
- 用 Device/MCP 重连重置免费额度或资源归属。

## 6. 跨平台 Buyer Vault 读取

Local Device 与 MCP Connection 可以读取同一 Buyer Vault，但必须分别完成：

1. durable caller authentication；
2. exact-audience temporary Vault window；
3. 对需要首次揭示的工件完成 artifact-specific consent。

CLI/MCP 连接不等于持续读取授权，OAuth 登录也不等于首次揭示或退款授权。

最终产品、API、Schema 和测试合同由 Compose 文档
`V3_CROSS_PLATFORM_BUYER_VAULT_READ_IMPLEMENTATION_PLAN.md` 负责。

## 7. 平台不兼容时

如果平台不能安全完成标准 OAuth 或保存/刷新 Token：

- 有本地 Shell 时使用 bundled CLI；
- 没有本地 Shell 时标记 MCP 不支持；
- 不接受静态 personal bearer；
- 不要求用户在聊天中粘贴 Token；
- 不把 Token做成普通 Skill setting。

## 8. 验证门禁

- CLI 升级前后 Device ID 和私钥 hash 不变；
- MCP 连接/刷新/撤销不修改 Local Device 文件；
- Device 与 MCP auth scheme 互相拒绝；
- 两个 Connection 与两个 Agent Instance 的 Vault audience 相互隔离；
- Access Token 刷新无需用户或模型参与；
- Vault window 到期不会销毁 OAuth/Device durable identity；
- 日志、bundle、tool output 和 repo secret scan 无凭据；
- 平台失败时没有静默线路切换。
