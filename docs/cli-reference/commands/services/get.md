# `itpay services get`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

读取一笔 Service Execution 的紧凑状态、关键节点和当前首选动作。它面向恢复和用户解释，不是原始 event dump。

**上游：** execution ID。
**下游：** 当前首选命令；深度诊断才使用 `events`。

## 语法与参数

```bash
itpay services get <service_execution_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `<service_execution_id>` | 是 | `services start/list/next` 返回的 execution ID。 |
| `--json` | 否 | 输出单个标准 JSON envelope；默认输出相同事实的简洁文本。 |

命令使用当前签名 Agent Device session；可见范围由 Backend 按设备和已绑定 Buyer account 决定。

## 当前状态与恢复

返回原执行的安全状态、当前动作和最近20个公开节点；超出时 timeline_truncated=true。没有动作就停止，不从时间线推导重放步骤。需要诊断且当次明确建议时才读取 services events。

购买材料、完整 review 和待填输入使用当次返回的完整模板，不手拼字段。缺合同、材料过期、权限拒绝或读取失败按实际原因处理，不能自动切到旧购买链或创建替代执行。

退款访问锁优先于交付；failed/refunded/cancelled 等终态不创建 Checkout。历史已交付记录不证明当前授权仍有效。默认不返回供应商原始数据、凭据、内部binding或完整事件DTO。

## Agent Type / Host

所有正式支持的 Local Agent Type 的状态、timeline、instruction 和 next 相同。本命令没有二维码或 Host handoff。
