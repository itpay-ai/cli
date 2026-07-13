# `itpay refund create`

## 范围与意义

为一笔订单提交退款意图。Refund Owner 从订单推导 Buyer、支付、金额、币种、消费事实和审核策略；Agent 只提交订单和用户原因。

**上游：** `order <id>` 或用户明确提出退款。  
**下游：** `refund watch <refund_request_id>`，或在 `can_cancel=true` 时由用户选择取消。

退款成功落库与交付冻结是同一事务；CLI 不自行锁单，也不预测自动退款结果。

## 语法与参数

```bash
itpay refund create --order <order_id> [--reason <reason>] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--order <order_id>` | 是 | 当前 Buyer 或已绑定 Agent 可见的订单。 |
| `--reason <reason>` | 否 | 默认 `buyer_requested`；只记录用户原因，不决定政策。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

CLI 使用 Device Authority 或已有 Buyer bearer，并用订单+原因生成稳定幂等操作 ID。不得提交退款金额、币种、支付 ID、消费状态或审核模式。

## 标准输出

```json
{
  "status": "requested",
  "result": {
    "refund_request_id": "<refund_id>",
    "order_id": "<order_id>",
    "decision_mode": "automatic",
    "refund_status": "accepted",
    "consumption_state": "unconsumed",
    "access_locked": true,
    "can_cancel": true
  },
  "instruction": "退款处理中，交付已冻结；不要 reveal、授权或读取结果。",
  "next": {
    "command": "itpay refund watch <refund_id> --json",
    "reason": "跟踪同一退款"
  },
  "recovery": []
}
```

`decision_mode` 的服务器枚举为 `automatic|manual`。已消费交付通常返回 `manual` / `policy_review_required`；instruction 明确等待人工审核。`status` 表示提交动作已完成，`result.refund_status` 才是退款状态机当前状态。

若服务器返回退款终态，`next` 为 `null`。文本输出依次显示 result 字段、instruction 和一个 next，不输出支付或 Provider 内部数据。

重复提交同一活跃退款时 Backend 返回已有请求，不创建第二笔；CLI 继续跟踪该 `refund_request_id`。

## 异常处理

缺少 `--order` 时在 HTTP 前返回 `order_required`，要求恢复当前 Service Execution，不猜订单 ID。

订单不可见、已退款、无可退款支付或状态不允许时 fail closed：

```json
{
  "status": "error",
  "error": {
    "code": "<server_error_code>",
    "message": "<server reason>"
  },
  "instruction": "确认订单属于当前账号且可退款；不要修改金额、支付或消费事实。",
  "next": null,
  "recovery": [
    {
      "command": "itpay order <order_id> --json",
      "reason": "检查订单和交付锁"
    },
    {
      "command": "itpay refund list --order <order_id> --json",
      "reason": "检查已有退款"
    }
  ]
}
```

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 使用相同 Device Authority、退款政策和输出。未绑定订单时不得改用新 Device ID、Buyer ID 或开发者权限绕过 Owner 鉴权。
