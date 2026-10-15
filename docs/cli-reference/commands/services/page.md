# `itpay services page`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

读取已保存 Result Item 的同版本分页。分页来自 Backend 存储的当前结果版本，不重新调用 Provider、不消耗查询额度，也不产生新的 Execution。

**上游：** `services run`、`services next` 返回的分页提示（`catalog_page.next_offset`）。  
**下游：** 继续翻下一页，或在用户明确选择后用 `booking_offer` 承接购票。

本命令不接受 Buyer token、capability 或服务输入；CLI 可把已有保存车次投影成便于比较的业务行和购买模板，不增加供应商事实。Agent 不向用户暴露 `safe_payload`、Execution 或内部 ID。

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
| `--limit` | 否 | 页大小，`1` 到 `20` 的整数；默认 `20`。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出本页候选标题的简洁文本。 |

需要有效 Agent Device session。

## 当前分页输出

返回同快照的 total、offset、count、下一偏移及完整业务行；页大小受最终输出字节预算约束，不截断一条线路。读尽 next=null；有后页只在还需比较时使用当次完整分页命令，不无意义翻完所有页。诊断或不可用方案保留原因，不把它们当可购买结果。

Exact 单车详情使用保存的 result_offset 和 limit=1，给出席别代码／名称、库存与当前完整购买模板。Smart 详情沿返回的同快照入口读取完整多段票计划。当前价格不等于锁价，凭据不自行拼接；完整输入和 continuation 从该详情原样承接。

参数、归属、快照或读取错误按当次真实原因恢复；保存结果读取不触发供应商、不消耗查询额度，不用新查询“刷新”分页。所有宿主使用相同事实。
