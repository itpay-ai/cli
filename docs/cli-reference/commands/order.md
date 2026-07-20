# `itpay order`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取一笔当前 Buyer 或已绑定 Agent 可见的订单摘要、交付模式和退款访问锁。它不会返回受保护交付内容、Vault ID、内部 delivery artifact 或 Checkout token。

**上游：** Checkout 完成、订单列表、邮件或 Service Execution 返回的 `order_id`。  
**下游：** `services next`、退款状态查询，或等待同一订单继续推进。

## 语法与参数

```bash
itpay order <order_id> [--host <host>] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `order_id` | 是 | 订单 ID。 |
| `--host <host>` | 否 | 兼容已有调用并校验 Host 名称；不改变订单事实或输出结构。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

CLI 使用 Agent Device Authority。设备完成首次付款绑定后，已登记在同一 Buyer account 的 Agent Type 可读取该账号订单；未绑定设备不能借此获得 Buyer 权限。

## 标准输出

```json
{
  "status": "delivered",
  "result": {
    "order_id": "<order_id>",
    "order_code": "<IP-code>",
    "amount": "<amount> <currency>",
    "delivery_mode": "vault_artifact",
    "access_locked": false,
    "service_execution_id": "<service_execution_id>"
  },
  "instruction": "根据 delivery_mode 使用对应读取入口；不要从订单摘要猜测受保护内容。",
  "next": {
    "command": "itpay services next <service_execution_id> --json",
    "reason": "读取交付状态"
  },
  "recovery": []
}
```

`delivery_mode` 当前为 `agent_visible_result` 或 `vault_artifact`，由 Delivery Owner 的 binding 返回，不从商品名或服务 ID 推断。文本输出依次显示同一组字段、instruction 和 next。

订单尚未交付时可以暂不包含 `delivery_mode` 和 `service_execution_id`，并只建议稍后重查同一订单。

## 退款访问锁

退款锁生效时，退款状态优先于交付入口：

```json
{
  "status": "delivered",
  "result": {
    "order_id": "<order_id>",
    "order_code": "<IP-code>",
    "amount": "<amount> <currency>",
    "delivery_mode": "vault_artifact",
    "access_locked": true,
    "service_execution_id": "<service_execution_id>",
    "refund": {
      "refund_request_id": "<refund_request_id>",
      "status": "accepted"
    }
  },
  "instruction": "退款访问锁已生效；不要 reveal、创建 grant 或读取交付结果。",
  "next": {
    "command": "itpay refund get <refund_request_id> --json",
    "reason": "读取退款的服务器状态"
  },
  "recovery": []
}
```

退款为 `succeeded` 等终态时 `next` 为 `null`；CLI 不恢复旧 grant，也不自行解除锁。

## 异常处理

不存在和不属于当前账号的订单都返回不透明 `not_found`。错误 instruction 要求核对当前账号/Agent 绑定，唯一恢复入口是：

```text
itpay services list --json
```

不得通过 403/404 差异探测其他账号订单，也不得新建订单掩盖错误 ID。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 返回完全相同的订单事实、instruction 和 next。`order` 是状态读取命令，不构造二维码、Markdown handoff 或 Host renderer 数据。
