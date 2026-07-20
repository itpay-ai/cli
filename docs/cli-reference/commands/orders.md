# `itpay orders`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

列出当前 account-scoped Buyer session 可见的订单摘要，用于恢复订单，不返回交付 payload。

**上游：** Buyer 登录并取得 account-scoped session。
**下游：** `order <id>`。

## 语法与参数

```bash
itpay orders [--limit <n>] [--status <status>] [--json]
```

| 参数 | 默认 | 说明 |
|---|---:|---|
| `--limit` | `20` | 最大订单数。 |
| `--status` | 全部 | 可选：`pending_payment`、`paid`、`delivery_pending`、`delivered`、`failed`、`partially_refunded`、`refunded`、`cancelled`。 |
| `--json` | 否 | 标准 JSON。 |

`--limit` 必须是 `1..100` 的整数。命令固定使用最新优先排序，不暴露修改排序的参数。

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "orders": [
      {
        "order_id": "<id>",
        "order_code": "<IP-code>",
        "status": "<status>",
        "amount": "<amount> <currency>",
        "created_at": "<RFC3339>"
      }
    ]
  },
  "instruction": "选择目标订单后读取详情；不要假设列表第一笔就是当前任务。",
  "next": { "command": "itpay order <order_id> --json", "reason": "读取所选订单" },
  "recovery": []
}
```

订单列表不得包含 `checkout_id`、订单 items、交付 artifact、Vault ID 或交付 payload。无匹配订单时返回：

```json
{
  "status": "no_orders",
  "result": { "orders": [] },
  "instruction": "当前账号没有符合条件的订单；不要猜测订单 ID。",
  "next": null,
  "recovery": [
    { "command": "itpay services list --json", "reason": "恢复当前 Agent 设备可见的执行" }
  ]
}
```

## 异常处理

结果按最新到最旧排列。缺少 Buyer session 时返回：

```json
{
  "status": "error",
  "error": {
    "code": "session_required",
    "message": "account-scoped Buyer session is required"
  },
  "instruction": "订单历史只对网页登录账号开放；不要伪造 Buyer token。Agent 可改为恢复当前设备绑定的 Service Execution。",
  "next": null,
  "recovery": [
    { "command": "itpay services list --json", "reason": "恢复当前 Agent 设备可见的执行" }
  ]
}
```

无效 `--limit` 和 `--status` 必须在发起 HTTP 请求前返回 `limit_invalid` 或 `order_status_invalid`。Order-scoped session 返回服务端的 `account_scope_required`；CLI 不降级鉴权，也不要求 Agent 手工构造 Buyer token。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 行为相同；只允许展示格式差异。
