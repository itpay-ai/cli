# `itpay orders`

## 范围与意义

列出当前 ItPay 账号的安全订单摘要。网页登录 Buyer Session，或具有有效
账号读取授权的 Local Device / MCP Connection 都可以使用。它不返回交付
payload、Checkout、支付凭证或内部 Buyer ID。

```bash
itpay orders [--limit <n>] [--status <status>] [--json]
```

| 参数 | 默认 | 说明 |
| --- | ---: | --- |
| `--limit` | `20` | 最大订单数，必须是 `1..100`。 |
| `--status` | 全部 | 可选订单状态过滤。 |
| `--json` | 否 | 输出标准 envelope。 |

## Agent/网页登录通用成功输出

```json
{
  "status": "listed",
  "result": {
    "orders": [{
      "order_code": "<IP-code>",
      "service_title": "<title>",
      "subject_label": "<subject>",
      "amount": "2.00 CNY",
      "paid_at": "<RFC3339>",
      "status": "delivered",
      "vault_artifact_count": 1
    }],
    "next_cursor": null
  },
  "instruction": "用编号、服务、购买对象、金额、时间、订单号和状态说明结果；不要假设第一笔就是用户要找的订单。",
  "next": null,
  "recovery": []
}
```

网页登录路径可保留内部 `order_id` 以支持既有 `order <id>` 读取；Agent
安全摘要路径只返回 Backend 已批准的 BuyerOrderSummary 字段。CLI 不把两种
响应错误拼成同一种 DTO。

## Agent 授权缺失

```json
{
  "status": "human_authorization_required",
  "result": { "intent": "list_purchase_history" },
  "instruction": "需要用户确认一次身份和只读权限；执行 next.command 生成入口。",
  "next": {
    "command": "itpay vault access --json",
    "reason": "创建一次账号读取授权"
  },
  "recovery": []
}
```

用户完成后重新执行原始 `orders` 命令。CLI 不要求 Agent构造或粘贴 Buyer
token，也不改用 Service Execution 猜测账号历史。

无匹配订单使用 `status=no_orders`、`orders=[]` 和 `next=null`。无效 limit
和 status 必须在 HTTP 前返回稳定合同错误。
