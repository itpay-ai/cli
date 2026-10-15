# `itpay services read-result`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

同一命令读取三种已保存结果：铁路 Exact 车次按页读取为紧凑业务行、铁路 Smart 快照分页紧凑车次目录，或持有效 grant 读取 Vault 保护内容。铁路读取免费、只读且不重新调用供应商。

**上游：** 铁路查询的已保存结果入口，或 `services next` 返回 `vault_artifact` 且用户已在订单页面授权。
**下游：** 铁路紧凑行中使用逐行 `detail.command` 读取购买条件；Vault 仅在 grant scope 和 TTL 内使用返回字段。

## 语法与参数

```bash
itpay services read-result <service_execution_id> [--snapshot <snapshot_id>] [--journey <journey_id>] [--offset <offset>] [--limit <limit>] [--all] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | 铁路查询或 Vault 交付对应的 execution ID。 |
| `--journey <journey_id>` | 否 | rail.progressive.v2 规划明细：读取指定 journey 的分段与席别选项；票计划按页返回。免费、属主校验、不触发供应商调用。 |
| `--snapshot <snapshot_id>` | 否 | 单独使用时读取该 Smart 已提交快照的紧凑线路页；与 `--journey` 配合时读取该线路详情页。 |
| `--offset <offset>` | 否 | Exact / Smart 保存结果从零开始的页偏移；不改变快照或重新查询。 |
| `--limit <limit>` | 否 | 保存结果当前页条数，1–20；Exact默认20条，Smart默认3条完整线路或3个票计划；必要时按最终输出字节缩小整行页。 |
| `--all` | 否 | 显式读取 Exact / Smart 保存目录全量；输出可能很大，常规读取应沿当前页的 next.command。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

Exact 执行按 offset/limit 读取已保存车次，返回 total、offset、count 和同一 read-result 的续页入口；不会把前100条冒充完整范围。Smart 使用 `--snapshot` 读取固定快照的默认小页，或用 `--journey` 读一条线路的票计划页；按返回的 next.command 续读同快照。这些读取不走 Vault grant。其他服务不带选择器时保持原授权路径。

Smart 保存目录按本次主推荐、其他合格线路、不可用或资格未知的诊断线路排列；`total` 仍是全部已保存时刻组合数，`qualification_counts` 分别说明当前合格、不合格、未知数。诊断线路保留车次、时刻和 `qualification_reasons`，其 `detail.command` 用于查看事实与原因，不表示可以购买。只有 `qualification_status=eligible` 且逐段票方案完整时，才给当前购买入口。历史快照缺资格字段按未知展示。`--all` 仍读取全部事实，不会重新查询铁路。

进度中的“保存组合”是具体车次与时刻组合数，不是不同站序数；“合格线路”按组合去重，profile 是同一组合下可推荐的席别及接驳选项数。模型实际调用和看到的合格组合以快照 coverage 为准；未穷尽范围不能称全网最优。推荐说明只披露当前方案实际涉及的地面交通、无座、跨日和分段票限制。

CLI 使用已登记设备的签名 session，不接受 Checkout token、Buyer token、`agent_device_id` 参数或开发者凭证。

CLI 直接请求 Backend 的当前有效 Grant。历史 `delivery_bindings` 不作为访问判断；Backend 负责验证当前 Vault、Agent instance、Buyer、scope、TTL 和退款锁。

## 结果与授权边界

铁路保存结果直接给完整业务行、范围／限制、同快照详情和可用方案的完整购买模板，不要求 Agent 写解析器。完整线路按当前页的 next 续读；只有需要比较时才翻页，不把局部范围说成全网最优。

Vault 结果返回当前 grant 批准字段、TTL 与 payload；历史交付不能代替有效授权。授权不足、过期或退款锁按当前返回的真实原因和原任务动作处理；不能借新 Device、Admin、数据库或旧grant绕过。一个grant不扩展到其他订单、execution或Agent实例。

文本与 JSON 使用相同事实。可见授权／官方入口按正式Skill与render-hosts展示，缺宿主信息只补可信上下文，不创建替代购买。没有适用动作时停止。
