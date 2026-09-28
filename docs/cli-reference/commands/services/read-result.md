# `itpay services read-result`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The same entry point supports Buyer workflows and the existing `itpay sell` Seller workflow.

## 范围与意义

同一命令读取三种已保存结果：铁路 Exact 车次页自动合并成紧凑业务行、铁路 Smart 快照完整紧凑车次目录，或持有效 grant 读取 Vault 保护内容。铁路读取免费、只读且不重新调用供应商。

**上游：** `services next` 返回 `vault_artifact`，且用户已在订单页面授权。  
**下游：** Agent 仅在 grant scope 和 TTL 内使用返回字段；没有自动后续命令。

## 语法与参数

```bash
itpay services read-result <service_execution_id> [--snapshot <snapshot_id>] [--journey <journey_id>] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | Vault 交付对应的 execution ID。 |
| `--journey <journey_id>` | 否 | rail.progressive.v2 规划明细：读取指定 journey 的完整卡片（分段、席别报价、接驳估计、风险标注）。免费、属主校验、不触发供应商调用。 |
| `--snapshot <snapshot_id>` | 否 | 单独使用时读取该 Smart 已提交快照的完整紧凑目录；与 `--journey` 配合时读取一条完整卡片。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

Exact 执行不带选择器时读取已保存全部车次，单次最多合并 100 条并给出明确续读位置。Smart 使用 `--snapshot` 读取固定快照，或用 `--journey` 读单程明细；这些读取不走 Vault grant。其他服务不带选择器时保持原授权路径。

CLI 使用已登记设备的签名 session，不接受 Checkout token、Buyer token、`agent_device_id` 参数或开发者凭证。

CLI 直接请求 Backend 的当前有效 Grant。历史 `delivery_bindings` 不作为访问判断；Backend 负责验证当前 Vault、Agent instance、Buyer、scope、TTL 和退款锁。

## 标准输出

```json
{
  "status": "granted_result_ready",
  "result": {
    "service_execution_id": "<id>",
    "grant_expires_at": "<RFC3339 time>",
    "granted_fields": ["<field>"],
    "payload": { "<granted_field>": "<value>" }
  },
  "instruction": "结果来自当前有效 Vault Grant；只使用本次授权字段，过期后停止读取并重新请求用户同意。",
  "next": null,
  "recovery": []
}
```

文本输出显示相同的 execution、到期时间、字段名和 payload，不附带 Vault ID、grant ID 或原始 scope。

## 异常处理

没有当前有效 Vault Grant（包括只有 Agent-visible 历史交付、未授权、过期、撤销或 wrong-scope）时，Backend 返回 `agent_access_denied`。CLI 指向：

```text
itpay services next <id> --json
```

不要从历史 Delivery Binding 推断当前模式，也不要使用数据库、Admin API 或新 Device ID 绕过授权。

退款访问锁由 Backend 在读取 Vault payload 的同一事务中拒绝：

```json
{
  "status": "error",
  "error": {
    "code": "delivery_locked_by_refund",
    "message": "delivery is locked by refund <refund_id>"
  },
  "instruction": "退款访问锁已生效；不要 reveal、创建 grant 或读取交付结果。",
  "next": null,
  "recovery": [
    {
      "command": "itpay refund get <refund_id> --json",
      "reason": "读取退款权威状态"
    }
  ]
}
```

其他 `agent_access_denied` 返回：

```json
{
  "status": "error",
  "error": {
    "code": "agent_access_denied",
    "message": "<server reason>"
  },
  "instruction": "请用户在订单页面重新授权；不要使用开发者权限绕过授权或退款锁。",
  "next": null,
  "recovery": [
    {
      "command": "itpay services next <id> --json",
      "reason": "检查交付模式和 grant 状态"
    }
  ]
}
```

一个 grant 只允许读取对应订单、execution、Agent instance 和批准字段。拒绝时不得改用数据库、Admin API 或新 Device ID 绕过。

## Agent Type / Host

同一 Buyer account 下已登记的正式 Local Agent Type 可按政策领取同一订单授权；每个类型仍需自己的有效 Device Authority。所有类型返回相同字段、TTL 和错误，不因 Host 扩大 grant scope。
