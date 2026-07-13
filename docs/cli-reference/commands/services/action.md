# `itpay services action`

## 范围与意义

记录用户或 Agent 对 Service Execution 的结构化动作，例如选择候选、批准、拒绝或取消。它不直接调用付费 Provider。

**上游：** `services invoke/next` 返回需要 action。
**下游：** 更新后的 `services next`。

## 语法与参数

```bash
itpay services action <service_execution_id> --action <action_type>
  [--actor-type <actor_type>] [--actor-id <actor_id>]
  [--status <pending|approved|rejected|expired|cancelled>]
  [--candidate <rank> | --result-item <result_item_id> --selected-candidate-hash <hash>]
  [--required-before <step>] [--input <key=value> ...] [--json]
```

普通 Agent 优先使用 `--candidate <rank>`，CLI 从当前 safe result 解析稳定 ID/hash。内部 ID 参数用于恢复和受控集成，不应要求用户提供。

## 标准输出

```json
{
  "status": "action_recorded",
  "result": { "service_execution_id": "<id>", "action_type": "<type>", "action_status": "<status>" },
  "instruction": "动作已记录，读取服务端计算的新状态；不要自行假设下一 capability。",
  "next": { "command": "itpay services next <id> --json", "reason": "取得更新后的首选动作" },
  "recovery": []
}
```

rank 不存在、action 不允许或 status 非法时不写 action；返回当前可选项和 `services next`。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 行为相同。需要人确认时 instruction 必须明确“先询问用户”，不能因 Desktop Host 自动代替用户选择。

