# `itpay services get`

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

## 标准输出

```json
{
  "status": "shown",
  "result": {
    "service_execution_id": "<id>",
    "service_id": "<service_id>",
    "status": "<status>",
    "phase": "<phase>",
    "current_capability_id": "<optional capability>",
    "updated_at": "<time>",
    "timeline": [
      {
        "sequence": 1,
        "step": "<public step>",
        "status": "<status>",
        "phase": "<phase>",
        "occurred_at": "<time>"
      }
    ],
    "delivery_mode": "<optional mode>"
  },
  "instruction": "时间线仅用于解释和恢复；按当前首选动作继续，不要重放已完成步骤。",
  "next": { "command": "<state-derived command>", "reason": "继续当前首选动作" },
  "recovery": [
    { "command": "itpay services events <service_execution_id> --json", "reason": "仅在需要完整诊断事件时使用" }
  ]
}
```

当 execution 为 `failed`、`refunded` 或 `cancelled` 时，`next` 必须是 `null`；只允许通过 `services events` 诊断终止原因，不得建议重放 capability 或创建 Checkout。

`timeline` 只保留最近 20 个公开节点；超过时增加 `timeline_truncated: true`。它不返回 event ID 或 `redacted_summary`。交付存在时可增加 `delivery_mode`；退款锁存在时增加 `access_locked` 和退款 ID/status，并优先返回锁定 instruction。

## 异常处理

默认不返回原始 events、Provider metadata、内部 bindings、graph projection、capability schema、candidate hash、client context 或完整 payload。需要完整但仍经服务端脱敏的事件时才运行 `services events`。

execution 不存在或不属于当前身份时保留不透明 `not_found`，只恢复到 `itpay services list --json`；不得通过错误差异探测其他账号。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 的状态、timeline、instruction 和 next 相同。本命令没有二维码或 Host handoff。
