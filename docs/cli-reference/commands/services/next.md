# `itpay services next`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取一笔 Service Execution 的当前状态，并只返回一个首选下一步。若交付模式允许 Agent 直接读取，本命令同时返回完整 safe result。

**上游：** `services start`、`invoke`、`action`、`checkout`，或一次中断恢复。  
**下游：** 一个可执行命令、需要用户完成的候选选择或授权，或 Arazzo workflow 真正到达终态。

本命令不返回原始 Backend DTO、capability 列表、内部 result ID/hash、Arazzo workflow、binding 或重复 guidance。

Backend 会根据当前 capability 选择 `current_delivery`；完整 `delivery_bindings` 仅是历史记录。CLI 不按数组位置猜测当前交付，同一 Execution 后续产生的新交付会取代旧交付成为默认结果。

## 语法与参数

```bash
itpay services next <service_execution_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | `services start` 或后续命令返回的 execution ID。 |
| `--since-snapshot <snapshot_id>` | 否 | rail.progressive.v2 增量读：传上次看到的 `snapshot_id`，未变化时只回扩展状态与 `result_not_updated`，不重复下发 journey 负载；永远不触发供应商调用。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

需要有效 Agent Device session。命令不接受 Buyer token、capability 或服务输入。

## 候选选择

免费或付费候选已经产生、Arazzo workflow 允许继续选择时，恢复输出必须包含当前 Result Set 的安全候选：

```json
{
  "status": "candidate_selection_available",
  "result": {
    "service_execution_id": "<id>",
    "items": [
      { "rank": 1, "title": "<title>", "safe_payload": { "<public_field>": "<value>" } }
    ]
  },
  "instruction": "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时，才提交对应编号；不要向用户提及 safe_payload、Execution 或内部 ID。",
  "next": {
    "command": "itpay services action <id> --action select_candidate --actor-type human --status approved --candidate <rank> --json",
    "reason": "仅在用户明确选择后锁定来源候选"
  },
  "recovery": []
}
```

该列表来自 Backend 的 `current_result_items`，CLI 不缓存或合并其他 Execution 的候选。

## Agent-visible 结果

```json
{
  "status": "result_ready",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "delivery_mode": "agent_visible_result",
    "items": [
      {
        "rank": 1,
        "title": "<title>",
        "safe_payload": { "<public_field>": "<value>" }
      }
    ]
  },
  "instruction": "付费搜索已完成。用编号、名称和可公开字段向用户说明结果，然后停止。只有用户明确选择候选并要求继续时才执行 next.command；不要提及 safe_payload 或自动购买后续报告。",
  "next": {
    "command": "itpay services action <id> --action select_candidate --actor-type human --status approved --candidate <rank> --json",
    "reason": "仅在用户明确选择候选并要求继续时执行"
  },
  "recovery": []
}
```

只有 Arazzo workflow 允许继续选择时才返回上述 `next`。若结果本身就是最终交付，instruction 要求用普通语言解释可公开字段并停止，且 `next: null`。文本输出可以保留 Agent 执行所需的 Execution 与 `delivery_mode`，但 Agent 不向用户暴露这些内部词、Result Item ID、Invocation ID 或 Hash。

## Vault 交付

未授权时不返回 result item 或 protected payload：

```json
{
  "status": "human_authorization_required",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "delivery_mode": "vault_artifact",
    "grant_status": "none"
  },
  "instruction": "这是当前 Arazzo step 对应的交付；请用户在订单页面授权，未授权前不要读取或猜测内容。",
  "next": {
    "command": "itpay services read-result <id> --json",
    "reason": "仅在用户确认授权后执行"
  },
  "recovery": []
}
```

用户已经授权、但服务端仍在按已发布执行图准备 Vault 交付时，必须只轮询同一 Execution：

```json
{
  "status": "result_preparing",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "delivery_mode": "vault_artifact",
    "grant_status": "pending",
    "preparation": {
      "status": "running",
      "total_nodes": 4,
      "completed_nodes": 2,
      "succeeded_nodes": 2,
      "failed_nodes": 0
    }
  },
  "instruction": "告诉用户：授权已经完成，付费结果仍在同一订单下准备，不需要再次付款或授权。然后只执行 next.command 查询同一笔服务；Agent 不创建新服务、付款页面或数据请求，也不提前读取。",
  "next": {
    "command": "itpay services next <id> --json",
    "reason": "等待同一 Execution 的交付准备完成"
  },
  "recovery": []
}
```

付款确认后仍处于 `wait`/Provider running 时，instruction 必须说明订单和付款已保留、用户不需要再次付款；若 Execution 最终失败，Agent 应恢复同一订单及退款状态，不能自动创建新购买或承诺退款。终态 `failed` 只允许说明本次服务没有正常完成，并读取现有事件用于诊断；不得把技术错误直接归咎于用户。

有效 grant 存在时：

```json
{
  "status": "grant_active",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "delivery_mode": "vault_artifact",
    "grant_status": "active",
    "grant_expires_at": "<RFC3339 time>"
  },
  "instruction": "这是当前 Arazzo step 对应的交付；用户授权有效，立即读取并遵守字段范围与到期时间。",
  "next": {
    "command": "itpay services read-result <id> --json",
    "reason": "读取当前有效 grant 的结果"
  },
  "recovery": []
}
```

额度耗尽或候选已确认并进入付费 continuation 时，`services next` 必须重复价格、用户确认原话、停止条件和禁止动作；普通单 Execution 的 next 使用 `services checkout`，不暴露 Quote/Cart/Buy 编排。

已有 Checkout 时，Backend 返回 `resume_checkout`，CLI 只能恢复同一 Checkout：

```json
{
  "status": "checkout_pending",
  "result": {
    "service_execution_id": "<id>",
    "service_id": "<service_id>",
    "phase": "checkout",
    "allowed_actions": [{ "type": "resume_checkout", "requires_human": true }]
  },
  "instruction": "当前 Execution 已经有一笔 Checkout。不要创建新的 Quote、Cart、Checkout 或 Execution。现在只执行 next.command，恢复并展示同一 Checkout 的付款入口。",
  "next": { "command": "itpay services checkout <id> --resume --json", "reason": "恢复同一 Checkout，不创建第二笔" },
  "recovery": []
}
```

付款已确认但 Provider 尚在履约时只能等待并再次读取同一 Execution；不得新建 Execution、Checkout 或再次付款。其他执行阶段只返回 Execution、service、phase、类型化 `allowed_actions` 和一个服务端状态导出的命令。CLI 只把 Backend 的动作类型渲染成命令，不执行 Publication 中的任意 shell 文本。完成或空结果后不得建议重放已失效的 invoke。

## 退款访问锁

订单存在 active 或永久退款锁时，该状态优先于 Agent-visible、Vault 和 grant guidance，不返回交付结果，也不再要求用户授权：

```json
{
  "status": "delivery_locked",
  "result": {
    "service_execution_id": "<id>",
    "access_locked": true,
    "refund": {
      "refund_request_id": "<refund_id>",
      "status": "<refund_status>"
    }
  },
  "instruction": "告诉用户退款仍在处理，原交付已按政策冻结。然后读取同一退款的权威状态；Agent 不读取交付、不创建授权或重复申请。",
  "next": {
    "command": "itpay refund get <refund_id> --json",
    "reason": "读取退款权威状态"
  },
  "recovery": []
}
```

`succeeded` 退款改为“交付永久关闭”，并返回 `next: null`。取消、拒绝或确定未产生资金影响的失败退款不再阻塞，但旧 grant 不会复活；用户必须重新授权。

## 额度暂停（试用/限流）

查询 Execution 因免费试用耗尽或限流被暂停时，状态为 `login_required` 或 `rate_limited`（不是 `failed`）。Execution 保留输入，可用同一 `services run <service> --execution <id> --json` 恢复——登录后或限流窗口过后从额度节点继续，不重放已完成阶段，不要新建 Execution 或重述行程。

```json
{
  "status": "login_required",
  "result": {
    "service_execution_id": "<id>",
    "service_id": "itpay-rail-exact",
    "admission": "login_required",
    "query_quota": [
      { "service_id": "itpay-rail-exact", "used": 2, "limit": 2, "remaining": 0 },
      { "service_id": "itpay-rail-smart", "used": 0, "limit": 2, "remaining": 2 }
    ]
  },
  "instruction": "如实告知该服务的免费试用次数与剩余；请用户登录后继续，原查询无需重新输入。",
  "next": { "command": "itpay auth login --json", "reason": "官方登录绑定后继续免费查询" },
  "recovery": [
    { "command": "itpay services run itpay-rail-exact --execution <id> --json", "when": "auth_bound" }
  ]
}
```

`rate_limited` 只等待 `retry_after_ms` 后恢复同一执行；不需要登录、不扣试用。

## 查询结果中的购买承接

铁路查询结果项可携带服务端签发的购票承接 `booking_offer`：

```json
{
  "rank": 1,
  "title": "C6908 二等座 11:48→12:20",
  "safe_payload": { "...": "..." },
  "booking_offer": {
    "service_id": "itpay-rail-booking",
    "selection_token": "sel_...",
    "expires_at": "2026-09-20T04:00:00Z"
  }
}
```

用户明确选择某班次/席别并要求购买时，用该 token 开启购票执行：

```bash
itpay services run itpay-rail-booking --input-json booking.json --json
# booking.json: {"passengers": 1, "selection": {"token": "<selection_token>", "seat_type": "O"}}
```

`booking_offer` 只是受条件约束的可选承接：查询完成本身已满足查询目标，不自动购买；过期 token 返回明确错误，恢复方式是按 `services run` 输入合同重新查询或显式提供 `legs`。

## 订票确认（booking review）

`itpay-rail-booking` 在报价前停在 `workflow:confirm_booking` 人工确认节点。`services next` 返回 `booking_review_required`，`human_action.context.review` 携带服务端投影：`draft_revision`、`legs`（含可编码的 `seat_options`）、`notice_version` 等。乘客身份信息永不在此投影，也不经 CLI 提交。

```json
{
  "status": "booking_review_required",
  "result": {
    "service_execution_id": "<id>",
    "service_id": "itpay-rail-booking",
    "human_action": {
      "action_type": "workflow:confirm_booking",
      "context": { "review": { "draft_revision": 1, "legs": [], "seat_options": {} } }
    },
    "required_fields": ["draft_revision", "passengers", "seat_type", "seat_preferences", "party_preference", "fallback", "notice_version", "accept_non_guaranteed"]
  },
  "instruction": "向用户展示行程与可选席别/座位偏好词表，并明确告知：座位偏好仅为请求、不保证分配。收集后经 --input-json 提交完整 JSON；draft_revision 以服务端当前值为准。",
  "next": { "command": "itpay services action <id> --action workflow:confirm_booking --actor-type human --status approved --input-json <file> --json", "reason": "提交用户确认后的行程确认/修订" },
  "recovery": [{ "command": "itpay services next <id> --json", "reason": "重新读取当前 draft_revision 后重试" }]
}
```

规则：

- `seat_preferences` 逐乘客一条，`passenger_index` 从 0 起、人数 1–5、取值限该席别 `seat_options`；`party_preference`、`fallback=automatic_assignment`、`notice_version`、`accept_non_guaranteed=true` 全部必填。
- `draft_revision` 必须等于投影值；服务端返回 `booking_review_changed` 时重新 `services next` 读取后重试，不得自行递增或重放旧 revision。
- 付款暂停且 review 仍开放时，`next` 指向 Checkout 恢复，`recovery` 附带修订命令（`services action … confirm_booking --input-json`）——修订回到同一执行重新报价，不产生第二笔订单或付款。
- 支付已在途/完成后 review 关闭，修订被拒绝；按返回的同一订单状态继续，不得新建执行。

## 异常处理

execution 不存在或不属于当前设备/账号时返回错误信封，并仅建议：

```text
itpay services get <service_execution_id> --json
```

不要创建替代 execution 来掩盖归属或状态错误。

## Agent Type / Host

所有正式支持的 Local Agent Type 返回完全相同的状态、safe payload、instruction 和 next。本命令不渲染二维码，也不包含 Host handoff。

## 渐进规划（rail.progressive.v2）

智能铁路规划服务在执行读模型上附带 `rail_planning` 投影：`readiness`（pending/ready/expired）、`search.expansion_status`（queued/running/paused/complete/cancelled/failed/expired）、`recommendation` 与 `alternatives` 行程卡片、以及服务端给出的完整 `available_actions` 命令。

- `running`/`queued`：稍后按 `next.command` 增量轮询同一执行；不要重新发起查询。
- `paused`：首批结果已就绪、扩展暂停等待用户意图；`expand_search` 是唯一会再消耗供应商配额的动作。
- `complete`：扩展收敛；展示推荐并等待用户选票。
- 选票走 `select_journey` 动作（命令在 `available_actions` 或卡片的 `select` 字段里，原样执行）；乘车人身份信息永远只在受保护 Checkout 页面填写。
