# `itpay services next`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取一笔 Service Execution 的当前状态，并只返回一个首选下一步。若交付模式允许 Agent 直接读取，本命令同时返回完整 safe result。

**上游：** `services start`、`invoke`、`action`、`checkout`，或一次中断恢复。  
**下游：** 一个可执行命令、需要用户完成的候选选择或授权，或 Graph 真正到达终态。

本命令不返回原始 Backend DTO、capability 列表、内部 result ID/hash、graph、binding 或重复 guidance。

Backend 会根据当前 capability 选择 `current_delivery`；完整 `delivery_bindings` 仅是历史记录。CLI 不按数组位置猜测当前交付，同一 Execution 后续产生的新交付会取代旧交付成为默认结果。

## 语法与参数

```bash
itpay services next <service_execution_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | `services start` 或后续命令返回的 execution ID。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

需要有效 Agent Device session。命令不接受 Buyer token、capability 或服务输入。

## 候选选择

免费或付费候选已经产生、Graph 允许继续选择时，恢复输出必须包含当前 Result Set 的安全候选：

```json
{
  "status": "candidate_selection_available",
  "result": {
    "service_execution_id": "<id>",
    "items": [
      { "rank": 1, "title": "<title>", "safe_payload": { "<public_field>": "<value>" } }
    ]
  },
  "instruction": "向用户展示编号和 safe_payload；若候选列表已满足用户目标，在此停止。仅在用户明确选择并希望继续时，才在当前 Execution 提交对应 rank。",
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
  "instruction": "付费模糊搜索已完成。现在把 items 中的编号、title 和 safe_payload 展示给用户，然后停止。本结果是 agent-visible，不要调用 read-result。若用户的目标只是搜索候选企业，任务已经完成；只有用户之后明确选择某个候选并要求继续时，才执行 next.command。不要自动购买后续报告。",
  "next": {
    "command": "itpay services action <id> --action select_candidate --actor-type human --status approved --candidate <rank> --json",
    "reason": "仅在用户明确选择候选并要求继续时执行"
  },
  "recovery": []
}
```

只有 Graph 允许继续选择时才返回上述 `next`。若结果本身就是最终交付，则 instruction 为“只使用 safe_payload，不调用 read-result”，且 `next: null`。文本输出依次显示 `status`、Execution、`delivery_mode`、候选及 instruction，不暴露 Result Item ID、Invocation ID 或 Hash。

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
  "instruction": "这是当前 Graph 步骤对应的交付；请用户在订单页面授权，未授权前不要读取或猜测内容。",
  "next": {
    "command": "itpay services read-result <id> --json",
    "reason": "仅在用户确认授权后执行"
  },
  "recovery": []
}
```

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
  "instruction": "这是当前 Graph 步骤对应的交付；用户授权有效，立即读取并遵守字段范围与到期时间。",
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
  "instruction": "退款处理中，交付已冻结；不要 reveal、创建 grant 或读取结果。",
  "next": {
    "command": "itpay refund get <refund_id> --json",
    "reason": "读取退款权威状态"
  },
  "recovery": []
}
```

`succeeded` 退款改为“交付永久关闭”，并返回 `next: null`。取消、拒绝或确定未产生资金影响的失败退款不再阻塞，但旧 grant 不会复活；用户必须重新授权。

## 异常处理

execution 不存在或不属于当前设备/账号时返回错误信封，并仅建议：

```text
itpay services get <service_execution_id> --json
```

不要创建替代 execution 来掩盖归属或状态错误。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 返回完全相同的状态、safe payload、instruction 和 next。本命令不渲染二维码，也不包含 Host handoff。
