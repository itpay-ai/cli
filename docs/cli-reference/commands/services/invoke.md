# `itpay services invoke`

## 范围与意义

调用当前 phase 允许的非付费 Agent-visible capability。输入先按 capability schema 校验，校验失败不得迁移 execution 或记录 Provider 已调用。

**上游：** `services start/next` 明确返回 invoke。
**下游：** 候选结果、人工 action、付费 Checkout 或新 execution。

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
  "instruction": "只向用户展示 safe_payload；若用户选择结果，记录对应 action。",
  "next": { "command": "itpay services action <id> --action <action_type> --actor-type human --status approved --candidate <rank> --json", "reason": "记录用户选择" },
  "recovery": []
}
```

## 无结果与额度耗尽

无结果时明确说明 Provider 已返回空结果，并根据服务端 graph 决定重试同一 execution 或启动新 execution。额度耗尽时返回付费 capability 的完整 `services checkout` 命令，不要求 CLI 自己识别服务。

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
  "instruction": "免费额度已用完且本次未调用 Provider；先向用户说明价格并确认购买。",
  "next": {
    "command": "itpay services checkout <id> --capability <paid_capability_id> --input <key=value> --json",
    "reason": "购买一次当前服务的付费 continuation"
  },
  "recovery": []
}
```

缺少 required input 时返回 `capability_input_invalid`，recovery 给出带占位符的同一 invoke 命令；CLI 和 Backend 都必须在 Provider 调用前拒绝，Backend 还必须在 execution/event/quota/invocation 写入前拒绝。错误调用付费 capability 时返回 `checkout_required` 和可直接运行的 checkout 命令；execution 状态、event、ProviderCalled 均保持不变。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 的 safe result 一致。instruction 可以适配对话表述，但不得隐藏 quota、价格或 schema 错误。
