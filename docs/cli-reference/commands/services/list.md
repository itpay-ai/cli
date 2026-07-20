# `itpay services list`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

恢复当前已登记设备或账号可见的 Service Execution 摘要。它不是批量 timeline 导出。

**上游：** 本地句柄丢失、404 recovery 或用户要求查看历史任务。
**下游：** `services next <selected_id>`。

## 语法与参数

```bash
itpay services list [--limit <number>] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--limit <number>` | 否 | 返回数量，默认 10；必须是 1 到 100 的整数。只有最近结果找不到目标时才扩大。 |
| `--json` | 否 | 输出单个标准 JSON envelope；默认输出每条一行的简洁文本。 |

命令使用签名 Agent Device session。Backend 按 `updated_at DESC` 返回当前设备或已绑定 Buyer account 可见的执行；CLI 保留该顺序，不在本地推断归属。

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "executions": [
      { "service_execution_id": "<id>", "service_id": "<service_id>", "status": "<status>", "phase": "<phase>", "updated_at": "<time>" }
    ]
  },
  "instruction": "结果按最新到最旧排列，默认只列最近 10 条；找不到目标时再扩大 limit。",
  "next": { "command": "itpay services next <latest_service_execution_id> --json", "reason": "默认恢复最新执行" },
  "recovery": []
}
```

不得为每条 execution 附加完整 guidance、capabilities、result items、events、candidate hash、client context 或内部 binding。若用户指定了另一条，Agent 应用该行 ID 替换默认最新 ID 后运行 `services next`。

无结果时返回 `no_executions`、空数组和 `itpay catalog list --json`。

非法 limit 在请求 Backend 前返回：

```json
{
  "status": "error",
  "error": { "code": "limit_invalid", "message": "--limit must be an integer from 1 to 100" },
  "instruction": "使用 1 到 100 的整数 limit；本次未读取服务端列表。",
  "next": null,
  "recovery": [
    { "command": "itpay services list --limit 10 --json", "reason": "使用默认上限重试" }
  ]
}
```

身份或 Backend 错误保留服务端错误码，只建议 `readyz` 和重新读取列表；不得猜测 ID。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 返回相同列表格式；Agent instance 权限决定可见范围。本命令没有 Host handoff。
