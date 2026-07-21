# 核心任务一：MCP 专用认证系统

状态：待实施

## 1. Current State

### CLI Device Authority

当前 `src/state/device_authority.ts`：

- 每个本地安装生成一把 Ed25519 私钥。
- 私钥和 Device 状态存放在 `~/.itpay-v3/device`，owner-only 权限。
- 一个 production Device registration 下按 `agent_type` 建立 Agent Instance。
- CLI 通过 challenge 签名取得短期 Device session。
- 受保护请求使用 `Authorization: ItPayDevice ...` 加请求签名。
- session 失效只续期一次；已撤销的 v2 registration 不会静默替换。

这套系统回答的是“哪个本地 Agent 设备在调用”，不是“哪个付费用户连接了 MCP”。

### Buyer Bearer

`src/state/config.ts` 可以从 `ITPAY_BEARER_TOKEN` 读取账号 Bearer token，供 `orders` 等账号范围命令使用。它是外部注入能力，不是平台 OAuth 连接系统，不应直接扩展成把 token 写进 Skill bundle。

### 问题

云端 Chat 平台不能稳定访问用户电脑上的 `~/.itpay-v3`。即使 Skill 在沙箱里写出同名目录，那也是平台执行容器的临时身份，不是用户本机身份，也不能作为订阅、订单或支付权限的长期主键。

## 2. Target Behavior

新增远程 MCP OAuth 通道：

```text
Platform -> OAuth authorize -> ItPay login/consent
         <- authorization code
Platform -> token endpoint (code + PKCE)
         <- access token + refresh token
Platform -> MCP tool + Bearer access token
MCP      -> validate issuer/audience/scope/expiry
MCP      -> principal.user_id
Backend  -> account/entitlement/order authorization
```

完成后：

- MCP 通过 ItPay 用户身份追踪收费、套餐、订单与权限。
- CLI 继续通过 Device Authority 追踪本地 Agent 设备和 Agent Instance。
- 用户可以显式把 Device 关联到同一 ItPay account，但关联不改变认证方式。
- 两套 token 具有不同 issuer/audience、Header scheme、存储位置和撤销域。
- 后端授权逻辑接收统一 principal，但不混淆 principal 类型。

不应该改变：

- 现有 CLI 私钥位置、Device 注册协议、签名格式和一次性 session 恢复规则。
- `https://app.itpay.ai` production Backend 固定规则。
- Checkout 外部人类确认和服务端支付状态权威性。

## 3. Scope

### In scope

- ItPay OAuth Authorization Server 所需的 authorize、token、refresh、revoke 和 metadata。
- MCP resource server 的 Bearer token 验证。
- PKCE、state、精确 redirect URI、scope、audience、过期和撤销。
- OAuth subject 到现有 ItPay `user_id` 的映射。
- 平台 OAuth client/connection 记录。
- MCP 工具级 scope 与敏感写操作确认策略。
- CLI Device 与用户账号的可选显式关联。
- 审计日志、最小化返回、测试账号和平台审核所需演示凭据。

### Out of scope

- 重写 CLI Device Authority。
- 让 MCP 读取或迁移本地 Device 私钥。
- 让平台 Access Token 代替支付确认。
- 在聊天内容中采集支付卡、支付密码、验证码、钱包私钥。
- 为每个平台建立独立 ItPay 用户表。

## 4. 认证边界

### Principal 类型

后端至少明确区分：

```ts
type Principal =
  | { kind: "device"; deviceId: string; agentInstanceId: string; agentType: string }
  | { kind: "user"; userId: string; oauthClientId: string; scopes: string[] };
```

不要求实际代码使用这个 TypeScript 类型，但授权层必须保留等价区分。禁止根据“有 Authorization Header”就把两者当成同一种账号。

### Header 与 audience

| 通道 | Header | audience | 用途 |
| --- | --- | --- | --- |
| CLI | `Authorization: ItPayDevice <session>` + 签名 Headers | Device API | 本地设备、Agent Instance、设备额度与执行 |
| MCP | `Authorization: Bearer <oauth_access_token>` | ItPay MCP resource | 用户账号、套餐、订单和 MCP 工具 |

Bearer token 不能被 CLI Device middleware 接受；Device session 不能被 MCP middleware 接受。鉴权失败返回 401，授权不足返回 403，不做静默降级。

### 服务端身份关系

建议关系而非第二套用户系统：

```text
itpay_users
  id

oauth_clients
  client_id
  platform
  redirect_uris
  status

oauth_grants
  user_id -> itpay_users.id
  client_id -> oauth_clients.client_id
  scopes
  revoked_at

agent_devices
  optional_linked_user_id -> itpay_users.id
```

Access token 的 `sub` 是稳定、不可猜测的 ItPay 用户 subject。若需要减少跨客户端关联，应使用 pairwise subject，并在服务端映射回同一 `user_id`；不要把 email、ChatGPT 用户名或平台会话 ID 当主键。

## 5. Implementation Steps

### Step 1：冻结现有 CLI 认证合同

依赖：无。

- 为现有 Device enrollment、session、请求签名、401 单次恢复补齐合同测试。
- 记录 Device API 可访问的路由集合。
- 确认 MCP 改动不会修改 `src/state/device_authority.ts` 的持久化 schema。

完成条件：加入 MCP 中间件前后，现有 CLI 测试结果和本地身份文件保持一致。

### Step 2：定义 OAuth issuer 和 MCP resource

依赖：Step 1。

- 选择正式 issuer，例如 `https://auth.itpay.ai`；若沿用 `app.itpay.ai`，也必须保持独立 OAuth 路径和密钥用途。
- 发布标准 Authorization Server metadata 和 MCP Protected Resource metadata。
- 明确 production MCP URL、resource audience、redirect URI 注册规则和允许的平台 client。
- Authorization Code 必须使用 PKCE；禁止 implicit flow 和 Resource Owner Password flow。

完成条件：平台可以发现授权端点，redirect URI 不能通配，code 只能使用一次且短期有效。

### Step 3：实现登录、同意和 token 生命周期

依赖：Step 2。

- 用户在 ItPay 页面完成登录；平台不能代收 ItPay 密码。
- consent 页面展示 client、scope、数据用途和撤销入口。
- access token 短期有效；refresh token 轮换并检测重放。
- 支持单 grant 撤销、全设备/全连接撤销和用户主动断开平台。
- 密钥轮换保留合理验证窗口；日志不记录原始 token 或 authorization code。

完成条件：登录、刷新、过期、撤销、重放和错误 redirect URI 均有自动测试。

### Step 4：在 MCP 服务建立认证和工具授权

依赖：Step 3。

- MCP 入口只接受匹配 issuer、audience、签名、有效期和未撤销 grant 的 Bearer token。
- 每个工具声明并验证最小 scope。
- 只读工具与创建 Checkout、退款等写工具分开。
- 敏感写工具保留平台确认和 ItPay 服务端幂等键。
- 工具响应去掉 token、内部用户 ID、Device ID、调试 payload 和不必要个人数据。

建议第一版 scope：

| Scope | 能力 |
| --- | --- |
| `catalog:read` | 浏览公开目录 |
| `checkout:write` | 创建或恢复当前用户的 Checkout handoff |
| `orders:read` | 读取当前用户订单摘要 |
| `refunds:write` | 按既有退款政策发起退款请求 |

不要第一版就增加通配 scope。

完成条件：越权工具返回 403；不能通过参数替换其他用户 ID；写操作保持幂等。

### Step 5：关联账号而不合并凭据

依赖：Step 3、Step 4。

- MCP OAuth grant 直接绑定 ItPay `user_id`。
- 本地 Device 若需要账号能力，通过网页显式关联到同一 `user_id`。
- 关联只写服务端关系，不把 OAuth refresh token 写入 `~/.itpay-v3/device`，也不把 Device 私钥传到服务端或 MCP。
- 解除关联不删除 Device 身份；撤销 OAuth 不删除 Device registration。

完成条件：分别撤销任一通道不会破坏另一通道；同一用户的订单权限由服务端政策决定。

### Step 6：平台审核材料与运维

依赖：Step 4。

- 建立无 MFA、无短信/邮件确认、无内网依赖的审核测试账号，仅含固定测试数据和限额。
- 准备 privacy policy、terms、support、数据删除和撤销说明。
- 记录 client、user、tool、scope、结果和 request ID；不记录 secret。
- 对 token 签发、失败登录、撤销、敏感工具建立告警。

完成条件：审核者可以独立完成正向和负向测试；运营可以按 user/client 撤销连接。

## 6. API / Data / Type Changes

预计涉及，具体路由名在服务端仓库调研后确定：

- OAuth metadata、authorize、token、revoke 端点。
- MCP protected resource metadata。
- OAuth client、grant、refresh-token family、consent/audit 数据。
- 统一但保留 `device`/`user` 区分的 principal 类型。
- MCP tool scope 和平台 action annotation。

CLI 公共命令和 `~/.itpay-v3/device` schema：无计划变更。

## 7. Tests / Verification

### 单元测试

- PKCE verifier、redirect URI、state、code 单次消费。
- issuer/audience/scope/expiry/signature/revocation。
- refresh rotation 和旧 token 重放。
- Device/Bearer scheme 互相拒绝。

### 集成测试

- 完整 OAuth 登录、MCP 调用、刷新、撤销。
- 同一 ItPay 用户从两个平台 client 登录。
- MCP OAuth 登录后，本地 CLI Device ID 和私钥 hash 不变。
- Device 撤销后 MCP grant 仍按自身状态工作；反向亦然。
- 订单、Checkout、退款的跨用户越权测试。

### 手动验证

- ChatGPT Connect/Disconnect。
- 另一个支持远程 MCP OAuth 的平台连接。
- 本地 CLI 同时运行并完成 `readyz`、目录、Checkout 恢复。

## 8. Risks / Uncertainties

- MCP 服务端代码不在当前 CLI 仓库，本文件定义合同，实施前必须在对应服务端仓库重新追踪现有用户/session 模块。
- 各平台对动态 client registration、redirect URI 和 token metadata 的细节可能不同；以平台实际连接测试为准。
- OpenAI 对金融交易和 PCI 数据有额外限制。MCP 只编排外部 Checkout，不把 OAuth 登录等同于付款授权。
- `ITPAY_BEARER_TOKEN` 的长期定位需要服务端确认；第一版不删除、不重命名，也不让 MCP 依赖该环境变量。

## 9. Checkpoint

本任务不需要改动当前 CLI 身份即可开始。实施时只有以下情况停下确认：

- 现有服务端没有可复用的 ItPay 用户主表；
- 必须改变 Device principal 或 quota 归属；
- 需要引入新的支付授权行为；
- 平台要求与这里冲突的 token 传递方式。
