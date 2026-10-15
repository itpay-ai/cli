# `itpay pay`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

为一个已存在的 Checkout 显式创建或刷新 Payment Intent。它只用于 Checkout 页面无法完成渠道动作时的受控集成恢复，不是普通 Buyer 流程。

本命令不能创建 Cart、Checkout、订单或付款证明，也不能把 Payment Intent 的渠道状态当作订单已付款。

**直接上游：** 当前官方入口或原 `checkout` reader 返回的同一组 `checkout_id` 与 display token。

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

`payment_verified` 的 instruction 必须先让 Agent 告诉用户付款已经确认、订单已记录且不需要再次付款；交付异常应恢复原订单并按 Refund Owner 的消费事实处理，不承诺自动、无条件或即时退款。Payment Intent 终态不是交付或退款终态，CLI 不据此替用户判断权益。

## 重试与刷新

- 数据库以 `(checkout_id, payment_method_type)` 作为 Payment Intent 业务唯一键。
- 相同 Checkout 与 method 顺序重跑返回同一个非终态 Intent，不依赖客户端自报幂等键。
- `--refresh` 只更新该 Intent 的渠道动作；不能创建第二个 Intent 或 Checkout。
- 响应丢失时重跑同一命令，不换 token 或 method。

## 保护与展示

仅在有明确授权的受控集成恢复中使用当前返回动作；普通 Agent 不自动调用 pay 或 buy --pay。错误按真实原因及原 Checkout 状态处理，不猜 token、换渠道掩盖未知结果或创建替代资源。

当前 handoff 按正式 Skill 与 render-hosts 展示；没有原生工具或可选图片时直接展示原始官方URL，不把按钮／二维码当付款事实。Host 不改变金额、Payment Intent、权限、幂等和状态保护。
