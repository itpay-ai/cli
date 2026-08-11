# `itpay orders`

## 范围与意义

列出当前 ItPay 账号的安全订单摘要。网页登录 Buyer Session，或具有有效
账号读取授权的 Local Device / MCP Connection 都可以使用。它不返回交付
payload、Checkout、支付凭证或内部 Buyer ID。

```bash
itpay orders [--limit <n>] [--status <status>] [--cursor <cursor>] [--host <host>] [--target <target>] [--json]
```

| 参数 | 默认 | 说明 |
| --- | ---: | --- |
| `--limit` | `20` | 最大订单数，必须是 `1..100`。 |
| `--status` | 全部 | 可选订单状态过滤。 |
| `--cursor` | 无 | Backend 返回的下一页游标；不得自行构造。 |
| `--host` | Agent Type 默认值 | 授权缺失时保留当前展示 Host；OpenClaw 必须显式提供。 |
| `--target` | 无 | OpenClaw 消息 Host 的可信会话目标。 |
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

当 `next_cursor` 非空时，`next.command` 使用同一 limit/status 和 Backend 返回的
cursor 读取下一页。Agent 只在用户需要查看更多订单时执行，不能修改或猜测
cursor。OpenClaw 的授权下一步必须保留原命令的 `--host` 和所需 `--target`；
若原命令未提供，CLI 会用明确占位符要求 Agent 从当前可信会话补齐。

无匹配订单使用 `status=no_orders`、`orders=[]` 和 `next=null`。无效 limit
和 status 必须在 HTTP 前返回稳定合同错误。
