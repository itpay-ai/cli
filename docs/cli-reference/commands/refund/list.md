# `itpay refund list`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

列出指定订单的退款记录，按最新到最旧排序。

**上游：** `order_id`。
**下游：** `refund get/watch <refund_id>`。

## 语法与参数

```bash
itpay refund list --order <order_id> [--json]
```

| 参数 | 必填 | 说明 |
|---|---:|---|
| `--order` | 是 | 用户订单 `order_id`，不可猜测。 |
| `--json` | 否 | 输出标准命令合同 JSON。 |

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "order_id": "<order_id>",
    "refunds": [
      {
        "refund_request_id": "<id>",
        "status": "<status>",
        "amount": "<amount> <currency>",
        "created_at": "<RFC3339>"
      }
    ]
  },
  "instruction": "已有活跃退款；继续跟踪同一笔，不要为该订单重复创建。",
  "next": { "command": "itpay refund get <refund_id> --json", "reason": "读取活跃退款" },
  "recovery": []
}
```

列表只返回选择退款所需的 ID、状态、金额和创建时间，不返回退款原因、消费证据、Admin 信息或支付渠道元数据。服务端按 `created_at DESC` 排序；CLI 优先引导至第一笔活跃退款，否则引导至最新记录。

无记录时 status=empty、refunds=[]、next=null。空列表不代表用户已同意退款；只有真实退款请求才按当前订单事实使用完整创建入口，不能自动提交。

## 鉴权与异常处理

允许订单 Owner 的 Buyer session、该订单的 order-scoped session，或绑定同一 Service Execution 的签名 Agent Device session。CLI 不自行判断归属；未知订单和无权访问统一按服务端不透明 `not_found` 处理。

缺少 `--order` 必须在 HTTP 前返回 `order_required`。鉴权或归属失败时 instruction 要求核对订单，recovery 指向 `itpay services list --json`；不得通过错误差异泄露退款是否存在。

## Agent Type / Host

所有正式支持的 Local Agent Type 的业务字段、instruction 和 next 完全相同；本命令没有 Host 渲染差异。
