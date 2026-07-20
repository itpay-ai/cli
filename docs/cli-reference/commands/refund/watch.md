# `itpay refund watch`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

轮询同一退款直到终态或 timeout。命令内部可以读取多次，但对外只输出一个最终信封，不把无变化轮询刷入 Agent 上下文。中断后可无副作用重跑。

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
| `--timeout <seconds>` | `120` | 必须为正数；可使用小数。 |
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
  "instruction": "退款已成功；交付永久关闭。",
  "next": null,
  "recovery": []
}
```

其他终态使用与 `refund get` 相同的锁、恢复资格和旧 grant 规则。

## Timeout 输出

Timeout 只表示本次 CLI 等待结束，不表示退款失败：

```json
{
  "status": "watch_timeout",
  "result": {
    "refund_request_id": "<id>",
    "last_status": "<status>",
    "access_locked": true,
    "can_cancel": true
  },
  "instruction": "退款仍在处理，稍后继续跟踪同一退款；不要重复申请。",
  "next": {
    "command": "itpay refund watch <refund_id> --json",
    "reason": "恢复轮询"
  },
  "recovery": []
}
```

网络、ID 或参数错误返回错误信封，并只建议 `itpay refund get <id> --json` 检查当前状态。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 返回相同退款事实。Desktop 不会把每次无变化轮询发送到用户对话；Host 不改变 timeout 或退款状态。
