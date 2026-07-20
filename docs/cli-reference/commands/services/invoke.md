# `itpay services invoke`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

调用当前 phase 允许的非付费 Agent-visible capability。输入先按 capability schema 校验，校验失败不得迁移 execution 或记录 Provider 已调用。

**上游：** `services start/next` 明确返回 invoke。
**下游：** 候选结果、人工 action、付费 Quote 或新 execution。

## 语法与参数

```bash
itpay services invoke <service_execution_id> --capability <capability_id>
  [--input <key=value> ...] [--json]
```

`--input` 可重复；必填 key 来自 `input_schema.required`，值按 schema 类型解析。Agent 不猜字段名。

## 有结果输出

```json
{
  "status": "result_ready",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "items": [{ "rank": 1, "title": "<title>", "safe_payload": {} }],
    "quota": { "remaining": 2, "limit": 3 }
  },
  "instruction": "向用户展示编号和 safe_payload；若候选列表已满足用户目标，在此停止。仅在用户明确选择并希望继续时，才在当前 Execution 提交对应 rank。",
  "next": { "command": "itpay services action <id> --action <action_type> --actor-type human --status approved --candidate <rank> --json", "reason": "记录用户选择" },
  "recovery": []
}
```

## 无结果与额度耗尽

无结果时明确说明 Provider 已返回空结果，并根据服务端 graph 决定重试同一 execution 或启动新 execution。额度耗尽时，普通单 Execution 流程返回完整的 `services checkout` 单项快捷命令；`services quote -> cart add --quote -> buy --cart` 只用于用户明确要求把多个独立 Execution 合并付款的高级流程。

```json
{
  "status": "quota_exhausted",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "<capability_id>",
    "items": [],
    "quota": { "remaining": 0, "limit": 3 },
    "checkout": {
      "capability_id": "<paid_capability_id>",
      "price": { "amount_minor": 10, "currency": "CNY" },
      "delivery_email_required": false
    }
  },
  "instruction": "免费额度已用完，本次没有调用 Provider，也尚未创建 Quote 或 Checkout。现在只向用户说明：‘继续当前请求需要支付 0.10 CNY，是否购买？’然后停止并等待用户明确回复。用户明确同意前，不要执行 next.command，不要新建 Execution，不要尝试其他 capability、quote、cart、buy、checkout 或 pay 命令。",
  "next": {
    "command": "itpay services checkout <id> --capability <paid_capability_id> --input <key=value> --json",
    "reason": "仅在用户明确同意支付 0.10 CNY 后执行；否则停止"
  },
  "recovery": []
}
```

缺少 required input 时返回 `capability_input_invalid`，recovery 给出带占位符的同一 invoke 命令；CLI 和 Backend 都必须在 Provider 调用前拒绝，Backend 还必须在 execution/event/quota/invocation 写入前拒绝。错误调用付费 capability 时不得给出购买旁路，只能回到同一 Execution 的 `services next`；execution 状态、event、ProviderCalled 均保持不变。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 的 safe result 一致。instruction 可以适配对话表述，但不得隐藏 quota、价格或 schema 错误。
