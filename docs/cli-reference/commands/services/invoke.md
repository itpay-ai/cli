# `itpay services invoke`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

调用当前 phase 允许的非付费 Agent-visible capability。输入先按 capability schema 校验，校验失败不得迁移 execution 或记录 Provider 已调用。

**上游：** `services start/next` 明确返回 invoke。
**下游：** 候选结果、人工 action 或付费 Quote。一次 invoke 没有结果或返回 Provider 错误时必须停止；只有用户之后明确提供新输入，才启动新的 execution。

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
  "instruction": "用编号、名称和可公开字段向用户说明候选；若候选列表已满足目标就停止。只有用户明确选择并希望继续时，才提交对应编号；不要向用户提及 safe_payload、Execution 或内部 ID。",
  "next": { "command": "itpay services action <id> --action <action_type> --actor-type human --status approved --candidate <rank> --json", "reason": "记录用户选择" },
  "recovery": []
}
```

## 无结果

Provider 已收到请求但没有匹配项时，该 invocation 成功完成、提交一次真实额度消费并返回权威剩余额度。CLI 不提供可自动执行的下一步：Agent 必须展示 0 个结果并停止，不得缩短、改写或猜测输入。

```json
{
  "status": "no_result",
  "result": {
    "service_execution_id": "<id>",
    "capability_id": "company_name_suggestion",
    "query": { "keyword": "北京赢在未来公司" },
    "items": [],
    "quota": { "remaining": 1, "limit": 3 }
  },
  "instruction": "没有找到与“北京赢在未来公司”匹配的结果。向用户展示本次为 0 个结果并停止。不要修改、缩短或猜测其他输入；只有用户明确提供新输入后，才能启动新的查询。",
  "next": null,
  "recovery": []
}
```

文本输出只包含 execution、capability、keyword、`results: 0`、quota 和同一条 instruction；不得附带 Provider raw payload、Operation ID 或调试信息。

## 额度耗尽

额度耗尽时，普通单 Execution 流程返回完整的 `services checkout` 单项快捷命令；`services quote -> cart add --quote -> buy --cart` 只用于用户明确要求把多个独立 Execution 合并付款的高级流程。

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
  "instruction": "免费额度已用完，本次没有发送到数据来源，也没有创建付款页面。只向用户说明：‘继续当前请求需要支付 0.10 CNY，是否购买？’然后停止等待。用户明确同意前，Agent 不执行 next.command，也不创建或尝试其他购买路径。",
  "next": {
    "command": "itpay services checkout <id> --capability <paid_capability_id> --input <key=value> --json",
    "reason": "仅在用户明确同意支付 0.10 CNY 后执行；否则停止"
  },
  "recovery": []
}
```

缺少 required input 时返回 `capability_input_invalid`，recovery 给出带占位符的同一 invoke 命令；CLI 和 Backend 都必须在 Provider 调用前拒绝，Backend 还必须在 execution/event/quota/invocation 写入前拒绝。错误调用付费 capability 时不得给出购买旁路，只能回到同一 Execution 的 `services next`；execution 状态、event、ProviderCalled 均保持不变。

## Provider 请求前连接失败

如果 Backend 能确认请求未发出，返回固定的终态错误，不暴露 DNS、IP、Provider URL 或凭证诊断：

```json
{
  "status": "error",
  "error": {
    "code": "provider_connection_unavailable",
    "message": "provider request was not sent; reserved quota was released"
  },
  "result": {
    "service_execution_id": "<id>",
    "provider_called": false,
    "quota": { "remaining": 3, "limit": 3 }
  },
  "instruction": "告诉用户本次查询没有发送到数据来源，免费额度已保留，然后停止。不要转述技术错误、自动重试或进入付费路径；只有服务恢复且用户明确要求重新查询后才能开始新的查询。",
  "next": null,
  "recovery": []
}
```

`result.quota` 是释放预留后的权威余额，不是请求前预留时的临时值。该终态不允许 CLI 猜测网络修复、重复 invoke 或转入购买。连接恢复后也不能复用失败 Execution；必须同时满足“运营已确认恢复”和“用户明确要求再次查询”，才创建新 Execution。

## Provider 输入、临时和契约错误

Provider 已收到请求时，Backend 返回同一 Execution 的权威调用和额度事实。CLI 不读取 raw payload，也不自行推断错误种类。

明确输入错误：

```json
{
  "status": "error",
  "error": { "code": "provider_input_rejected", "message": "输入的名称不合法" },
  "result": {
    "service_execution_id": "<id>",
    "provider_called": true,
    "quota": { "remaining": 0, "limit": 3 }
  },
  "instruction": "告诉用户数据来源明确表示当前输入无效，并按 result.quota 说明额度状态，然后停止。不要转述内部错误、自行修改输入、重试或创建新查询；只有用户明确提供新输入后才能重新查询。",
  "next": null,
  "recovery": []
}
```

契约错误：

```json
{
  "status": "error",
  "error": { "code": "provider_contract_mismatch", "message": "provider response did not match the published contract" },
  "result": {
    "service_execution_id": "<id>",
    "provider_called": true,
    "quota": { "remaining": 0, "limit": 3 }
  },
  "instruction": "告诉用户平台暂时无法正确解释数据来源的响应，这不是用户输入问题，并按 result.quota 说明额度状态。立即停止，不要修改输入、重试、创建新查询或进入付费路径。",
  "next": null,
  "recovery": []
}
```

`provider_temporarily_unavailable` 同样必须停止且不得自动重试。输入错误、临时错误和契约错误都不得返回 `next.command` 或 recovery 命令；新的 Provider 请求只允许来自用户后续明确提出的新输入。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`kimi-code`、`openclaw` 七种 Agent Type 的 safe result 一致。instruction 可以适配对话表述，但不得隐藏 quota、价格或 schema 错误。
