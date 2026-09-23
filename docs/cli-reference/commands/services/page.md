# `itpay services page`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取已保存 Result Item 的同版本分页。分页来自 Backend 存储的当前结果版本，不重新调用 Provider、不消耗查询额度，也不产生新的 Execution。

**上游：** `services run`、`services next` 返回的分页提示（`catalog_page.next_offset`）。  
**下游：** 继续翻下一页，或在用户明确选择后用 `booking_offer` 承接购票。

本命令不接受 Buyer token、capability 或服务输入，不返回原始 Backend DTO 之外的额外事实；Agent 不向用户暴露 `safe_payload`、Execution 或内部 ID。

## 语法与参数

```bash
itpay services page <service_execution_id> <result_item_id> [--offset <offset>] [--limit <limit>] [--cursor <rcur_n>] [--json]

rail.progressive.v2 中 `<result_item_id>` 也可以是规划快照 ID（`rps_…`，见 `services next` 返回的 `snapshot_id`）：分页读取该不可变快照内的 journey 卡片，`--cursor` 使用上一页返回的 `rcur_<offset>` 不透明游标。
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | 产生该结果集的 Execution ID。 |
| `result_item_id` | 是 | `services next` 或分页响应中的 `service_capability_result_item_id`。 |
| `--offset` | 否 | 从零开始的候选偏移；默认 `0`，必须是非负整数。 |
| `--limit` | 否 | 页大小，`1` 到 `20` 的整数；默认 `5`。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出本页候选标题的简洁文本。 |

需要有效 Agent Device session。

## 分页信封

有候选返回 `result_page`，读尽返回 `result_page_end`：

```json
{
  "status": "result_page",
  "result": {
    "service_execution_id": "<id>",
    "service_capability_result_item_id": "<item_id>",
    "offset": 0,
    "limit": 5,
    "total": 63,
    "count": 5,
    "next_offset": 5,
    "page": { "catalog_page": { "...": "..." }, "candidates": [ { "title": "<title>" } ] }
  },
  "instruction": "读取的是已保存结果的同版本分页，不重新查询、不消耗额度。用普通语言向用户说明本页候选；铁路应付与地面估算费用分开表述；不要提及 safe_payload、Execution 或内部 ID。",
  "next": { "command": "itpay services page <id> <item_id> --offset 5 --json", "reason": "读取同版本结果的下一页" },
  "recovery": []
}
```

`next_offset` 为 `null` 时 `next` 为 `null`；`offset > 0` 时 `recovery` 提供回到第一页的命令。页内候选可携带 `booking_offer`，承接方式与 `services next` 结果一致。

## 异常处理

`--offset` 非负整数、`--limit` 必须在 `1`–`20` 内，否则在发起请求前返回 `offset_invalid` / `limit_invalid` 信封，不消耗服务端分页。execution 或 result item 不存在、不属于当前设备/账号时返回错误信封，并仅建议：

```text
itpay services next <service_execution_id> --json
```

分页读取的是已保存的同版本结果；不要重新发起查询或新建 execution 来"刷新"分页。

## Agent Type / Host

所有正式支持的 Local Agent Type 返回完全相同的状态、分页事实、instruction 和 next。本命令不渲染二维码，也不包含 Host handoff。
