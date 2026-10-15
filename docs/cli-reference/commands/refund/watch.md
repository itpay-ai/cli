# `itpay refund watch`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

有界读取同一退款，直到状态变化、人工／结果未知、终态或 timeout。命令内部可以读取多次，但对外只输出一个最终信封，不把无变化轮询刷入 Agent 上下文。中断后可无副作用重跑。

**上游：** active refund。  
**下游：** `succeeded`、`failed`、`cancelled`、`rejected` 等终态，或稍后继续 watch。

## 语法与参数

```bash
itpay refund watch <refund_request_id> [--interval <seconds>] [--timeout <seconds>] [--json]
```

| 参数 | 默认 | 约束 |
| --- | --- | --- |
| `refund_request_id` | 无 | 必填。 |
| `--interval <seconds>` | `2` | 必须至少 1 秒。 |
| `--timeout <seconds>` | `20` | 必须为正数；可使用小数。 |
| `--json` | 关闭 | 输出一个可直接解析的 JSON 信封。 |

非法轮询参数在第一次 HTTP 请求前失败。

## 终态输出

```json
{
  "status": "watch_complete",
  "result": {
    "refund_request_id": "<id>",
    "order_id": "<order_id>",
    "decision_mode": "automatic",
    "refund_status": "succeeded",
    "consumption_state": "unconsumed",
    "access_locked": true,
    "can_cancel": false
  },
  "instruction": "先说明本次退款钱款已由ItPay确认成功；按原订单核对实际金额范围、履约及访问锁，不推断整单全部退款，不恢复旧授权或重复申请。",
  "next": null,
  "recovery": []
}
```

其他终态使用与 `refund get` 相同的锁、恢复资格和旧 grant 规则。特别是 `failed` 必须按 `failure_class` 区分 `known_no_effect`、`retryable`、`outcome_unknown` 和 `permanent`；任何一种都不向 Agent 返回重试命令。

## 等待边界

人工审核、outcome_unknown或关键状态变化立即交回权威快照，不继续等待，也不把人工审核覆盖成超时。等待到期只说明本次等待结束；非终态的next只读同一退款一次 get，不自动接力watch。只有用户需要时沿当次条件读取原退款。失败按failure_class保留停止和对账边界，不重复申请或承诺到账。

## Agent Type / Host

所有正式支持的 Local Agent Type 返回相同退款事实。Desktop 不会把每次无变化轮询发送到用户对话；Host 不改变 timeout 或退款状态。
