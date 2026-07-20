# `itpay services events`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

按 sequence 升序读取一笔 Service Execution 的受限诊断事件。它只用于解释异常或支持排查，不是正常业务流程，不返回事件 ID、内部摘要、Provider 数据或受保护交付内容。

**上游：** `services get/next` 无法解释异常状态，并明确建议读取事件。

**下游：** 回到 `services next` 获取当前可执行动作；事件本身不能用于重放步骤。

## 语法与参数

```bash
itpay services events <service_execution_id> [--after-sequence <n>] [--limit <n>] [--json]
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `service_execution_id` | 是 | - | 当前设备或账号可见的执行 ID。 |
| `--after-sequence` | 否 | `0` | 只返回 sequence 大于该非负整数的事件。 |
| `--limit` | 否 | `50` | 本页最多 `1..100` 条。 |
| `--json` | 否 | false | 返回标准命令 envelope。 |

CLI 在发起 HTTP 请求前校验数字参数。Backend 再执行归属鉴权和相同上限。

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "service_execution_id": "<id>",
    "after_sequence": 0,
    "returned_count": 2,
    "events": [
      {
        "sequence": 1,
        "type": "<public_event_type>",
        "status": "<public_status>",
        "phase": "<public_phase>",
        "capability_id": "<optional_capability_id>",
        "occurred_at": "<time>"
      }
    ]
  },
  "instruction": "事件仅用于诊断；不要从事件重放业务步骤，回到 services next 获取当前动作。",
  "next": {
    "command": "itpay services next <id> --json",
    "reason": "恢复正常服务流程"
  },
  "recovery": []
}
```

当返回条数等于 limit 时，`recovery` 增加一条使用最后 sequence 的下一页命令。空页仍返回 `listed` 和 `returned_count: 0`。

## 安全边界

CLI 只投影：`sequence`、`type`、`status`、`phase`、可选 `capability_id`、`occurred_at`。即使 Backend DTO 包含 `service_execution_event_id`、重复 execution ID 或 `redacted_summary`，CLI 也不输出。

不得输出 AppCode、Provider headers、raw payload、payload ref/hash、Buyer PII、token、签名、候选 hash、correlation ID 或 Admin note。

## 异常处理

| 错误 | 含义 | 恢复 |
| --- | --- | --- |
| `events_parameter_invalid` | sequence/limit 不是允许的整数。 | 查看本命令 help；未发 HTTP。 |
| `service_events_failed` | Backend 不可用或读取失败。 | 回到 `services next` 或当前身份的 `services list`。 |
| `not_found` | execution 不存在或不属于当前身份。 | 使用相同不透明错误，不区分两者。 |

## Agent Type / Host

五种正式 Agent Type 的事件字段、鉴权和 redaction 完全相同；Host 不影响可见性，也不产生 handoff。
