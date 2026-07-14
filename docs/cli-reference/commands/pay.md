# `itpay pay`

## 范围与意义

为一个已存在的 Checkout 显式创建或刷新 Payment Intent。它只用于 Checkout 页面无法完成渠道动作时的受控集成恢复，不是普通 Buyer 流程。

本命令不能创建 Cart、Checkout、订单或付款证明，也不能把 Payment Intent 的渠道状态当作订单已付款。

**直接上游：** `buy`、`services checkout` 或 `checkout` 返回的同一组 `checkout_id` 与 display token。

**直接下游：** `checkout` 读取同一 Checkout 的权威付款、订单和履约状态。

## 语法与参数

```bash
itpay pay \
  --checkout <checkout_id> \
  --method <alipay|wechatpay> \
  [--token <display_token>] \
  [--refresh] \
  [--host <host>] [--target <target>] [--json]
```

| 参数 | 必填 | 规则 |
|---|---:|---|
| `--checkout` | 是 | 已存在的 Checkout ID。 |
| `--method` | 是 | 只接受 `alipay` 或 `wechatpay`；非法值不得回退为默认渠道。 |
| `--token` | 条件必填 | 必须属于同一 Checkout。省略时只可恢复本机为该 Checkout 保存的 token。 |
| `--refresh` | 否 | 为同一个非终态 Payment Intent 刷新渠道动作，不创建替代 Checkout。 |
| `--host` | 否 | 默认由 `--agent-type` 推导，只影响 instruction。 |
| `--target` | 条件必填 | 只有要求目标会话的 IM Host 需要。 |
| `--json` | 否 | 输出紧凑机器合同。 |

API 安全合同要求后端验证 display token 是该 Checkout 当前有效的 `checkout_entry` token。CLI 提交 token 不是安全边界；只有后端验证通过才允许创建或刷新 Payment Intent。

## 标准输出

### 渠道动作可用

```json
{
  "status": "payment_action_ready",
  "result": {
    "checkout_id": "<checkout_id>",
    "payment_intent_id": "<payment_intent_id>",
    "payment": "waiting_user_payment",
    "amount": "<amount> <currency>"
  },
  "handoff": {
    "qr_image_url": "<optional_provider_qr>",
    "mobile_wallet_url": "<optional_wallet_action>"
  },
  "instruction": "<host_specific_escape_hatch_instruction>",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json",
    "reason": "读取同一 Checkout 的权威付款状态"
  },
  "recovery": []
}
```

只返回 Agent 执行当前步骤所需的四个事实和安全渠道动作。不返回 Provider order ID、Payment Attempt、原始 Provider 响应、Checkout DTO 或重复 guidance。

### 没有可展示动作

`requires_action` 但响应没有二维码或钱包链接时返回 `payment_action_pending`，不生成虚假 handoff；下一步仍读取同一 Checkout。

### 已确认或终态

- `verified`、`partially_refunded` 返回 `payment_verified`，不再展示付款动作。
- `failed`、`expired`、`refunded` 返回 `payment_unavailable`，不创建替代 Checkout。
- 两者都只引导 `checkout --id ... --token ... --json` 读取服务端事实。

## 重试与刷新

- 数据库以 `(checkout_id, payment_method_type)` 作为 Payment Intent 业务唯一键。
- 相同 Checkout 与 method 顺序重跑返回同一个非终态 Intent，不依赖客户端自报幂等键。
- `--refresh` 只更新该 Intent 的渠道动作；不能创建第二个 Intent 或 Checkout。
- 响应丢失时重跑同一命令，不换 token 或 method。

## 异常处理

| 错误码 | Agent 处理 |
|---|---|
| `payment_method_invalid` | 改用 `alipay` 或 `wechatpay`；本次没有 HTTP 请求。 |
| `checkout_token_required` | 从 `itpay next --json` 恢复同一 Checkout；禁止拼接其他 token。 |
| `target_required` | 为当前 IM Host 补充真实 target。 |
| `not_found` / token invalid | 视为同一个不透明资源错误，不探测 Checkout 是否属于他人。 |
| `invalid_state` | 回到 `checkout` 读取当前终态，不创建替代资源。 |
| `provider_payment_failed` | 保留同一 Checkout，稍后恢复；不声称已付款。 |
| `payment_intent_failed` | 执行 `itpay next --json` 恢复现有句柄。 |

## Agent Type / Host

| Agent Type | 默认 Host | Instruction |
|---|---|---|
| `codex-desktop` | `codex` | 把安全 handoff 实际发到当前 Codex 对话，然后查询 Checkout。 |
| `codex-cli` | `terminal` | 只在用户可见终端展示渠道动作。 |
| `claude-code-desktop` | `claude-code` | 把安全 handoff 发到当前桌面对话。 |
| `claude-code-cli` | `terminal` | 只在用户可见终端展示渠道动作。 |
| `workbuddy` | `plain-chat` | 把二维码或钱包链接发送到当前会话。 |

Host 只改变 instruction；Payment Intent ID、金额、状态、重试语义和权限必须一致。
