# `itpay services action`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

记录用户或 Agent 对 Service Execution 的结构化动作，例如选择候选、批准、拒绝或取消。它不直接调用付费 Provider。

**上游：** `services invoke/next` 返回需要 action。
**下游：** 候选选择成功时直接进入服务端允许的下一动作；其他动作通过更新后的 `services next` 恢复。

## 语法与参数

```bash
itpay services action <service_execution_id> --action <action_type>
  [--actor-type <actor_type>] [--actor-id <actor_id>]
  [--status <pending|approved|rejected|expired|cancelled>]
  [--candidate <rank> | --result-item <result_item_id>]
  [--required-before <step>] [--input <key=value> ...]
  [--input-json <file>] [--json]
```

| 选项 | 说明 |
|---|---|
| `--input <key=value>` | 逐项提交 action input；值可为 JSON 字面量（对象/数组/布尔/数字），可重复。 |
| `--input-json <file>` | UTF-8 JSON 文件；顶层必须是 object，整体作为 action input；文件不超过 256 KiB。适合嵌套结构（如订票确认的 `seat_preferences`）。**与 `--input` 互斥**：同时给出时在发起请求前返回 `service_action_invalid`。文件不存在、非合法 JSON 或顶层非 object 同样在本地报结构化错误，不发生网络写。 |

普通 Agent 优先使用 `--candidate <rank>`。CLI 只从当前 Execution 的 `current_result_items` 解析 Result Item ID；Backend 再读取权威 Invocation 和 Stable Hash。Agent 不提交 Hash，也不能使用其他 Execution 或外部来源的候选。`--result-item` 只用于已持有当前 Execution 内部句柄的受控恢复，不应要求用户提供。

## 规划动作（rail.progressive.v2）

`services next` 的 `rail_planning.available_actions` 会给出可直接执行的完整命令。规划动作只允许以下类型，由 planning owner 校验执行归属、plan 状态与幂等键，不影响 Arazzo `human_action` 状态机或公共执行状态：

| action_type | 供应商消耗 | 说明 |
| --- | --- | --- |
| `workflow:expand_search` | 有界新增查询 | 仅在扩展暂停（`expansion_status=paused`）时可用；必须带服务端下发的 `action_request_id`（`pa_…`）与 `expected_query_revision`，一轮一柄、用完作废。 |
| `workflow:refine_preferences` | 无（本地重排） | 用 `--input-json` 提交偏好补丁，对已保存证据重排序。 |
| `workflow:stop_search` | 无 | 停止未发送的扩展任务；不影响已开始或已完成的出票。 |
| `select_journey` | 无 | 记录用户选定：`--input journey_id=<rj_…>`；仅记录选择、不改排名，后续购买仍走既有报价与受保护 Checkout。 |

同一 `action_request_id` 相同内容重放返回原受理结果；相同 ID 不同内容会被判冲突。过期 `expected_query_revision` 的新动作被拒绝。

## 标准输出

```json
{
  "status": "candidate_selected",
  "result": {
    "service_execution_id": "<id>",
    "candidate": { "rank": 2, "title": "<title>" },
    "checkout": {
      "capability_id": "<paid_capability_id>",
      "price": { "amount_minor": 50, "currency": "CNY" },
      "delivery_email_required": true
    }
  },
  "instruction": "已选择 <title>。后续服务尚未购买。只向用户说明继续购买的价格和邮箱用途，请确认是否购买并提供邮箱，然后停止。用户明确同意并提供真实邮箱前，Agent 不执行 next.command，也不创建新的服务或付款页面。",
  "next": { "command": "itpay services checkout <id> --capability <capability_id> --email <email> --json", "reason": "仅在用户明确同意价格并提供真实邮箱后执行" },
  "recovery": [{ "command": "itpay services next <id> --json", "reason": "重新读取服务端允许的动作" }]
}
```

`next` 来自 action 写入后重新读取的类型化 `allowed_actions`，不是 CLI 根据服务名猜测。普通单 Execution 的付费 continuation 使用 `services checkout`；候选选择本身不代表用户已经同意购买。没有合法动作时返回 `next: null`。非候选 action 仍返回 `action_recorded` 并引导 `services next`。

rank 不存在、属于旧结果集或其他 Execution、action 不允许、status 非法时均不写 action；返回结构化错误并且只引导同一 Execution 的 `services next`。不得新建 Execution、重新 invoke 或构造候选 ID。相同候选重试幂等；同一结果集改选另一个候选返回冲突，不覆盖已批准事实。

订票类 `workflow:confirm_booking` 动作要求嵌套输入（`passengers`、`seat_type`、逐乘客 `seat_preferences`、`draft_revision`、`notice_version` 等），一律经 `--input-json <file>` 提交完整 JSON 对象。`draft_revision` 必须等于 `services next` 投影的 `context.review.draft_revision`；服务端拒绝 `booking_review_changed` 时重新读取后重试，不得自行递增。乘客姓名、证件号等身份信息不在此提交，仍由受保护 Checkout 页收集。

## Agent Type / Host

所有正式支持的 Local Agent Type 行为相同。需要人确认时 instruction 必须明确“先询问用户”，不能因 Desktop Host 自动代替用户选择。
