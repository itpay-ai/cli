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
  [--required-before <step>] [--input <key=value> ...] [--json]
```

普通 Agent 优先使用 `--candidate <rank>`。CLI 只从当前 Execution 的 `current_result_items` 解析 Result Item ID；Backend 再读取权威 Invocation 和 Stable Hash。Agent 不提交 Hash，也不能使用其他 Execution 或外部来源的候选。`--result-item` 只用于已持有当前 Execution 内部句柄的受控恢复，不应要求用户提供。

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

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`kimi-code`、`openclaw` 七种 Agent Type 行为相同。需要人确认时 instruction 必须明确“先询问用户”，不能因 Desktop Host 自动代替用户选择。
