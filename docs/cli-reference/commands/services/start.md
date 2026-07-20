# `itpay services start`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

按 Catalog 中的 `service_id` 启动一次 Service Execution，并返回当前可执行的唯一首选动作。不会调用 Provider、创建 Checkout 或订单。

**上游：** `catalog list` 或服务端明确要求新 execution。
**下游：** `services invoke`、`action`、`checkout` 或 `next`。

## 语法与参数

```bash
itpay --agent-type <agent_type> services start <service_id>
  [--host <host>] [--target <target>] [--json]
```

`service_id` 必须来自 Catalog。`--target` 只用于需要稳定消息目标的 Host，例如 chat/channel/open ID；它不是搜索词或其他业务输入。Buyer、Device 和 Agent instance 均来自签名 Agent session，不接受请求参数覆盖。

本命令不接收 capability 业务输入。它返回 `required_input` 和一条 `services invoke`（或其他当前合法动作）命令；把真实值填入那条命令的重复 `--input key=value`。例如企业关键词是 `--input keyword=美团`，不是 `--target 美团`。

## 标准输出

```json
{
  "status": "ready",
  "result": {
    "service_execution_id": "<execution_id>",
    "service_id": "<service_id>",
    "phase": "<phase>",
    "capability": {
      "capability_id": "<capability_id>",
      "required_input": ["<field>"],
      "free_quota_limit": 3
    }
  },
  "instruction": "填写首选 capability 的 required_input；一次只提交当前 execution 所代表的服务意图。",
  "next": {
    "command": "itpay --agent-type <agent_type> services invoke <execution_id> --capability <capability_id> --input <key=value> --json",
    "reason": "执行当前允许的能力"
  },
  "recovery": []
}
```

Start API 只提供免费额度上限，不提供当前剩余额度，因此本命令不得虚构 `remaining`。不得输出全部 capability DTO、contract version、graph ID、buyer/device ID 或重复 guidance。若服务不存在，recovery 为 `catalog list`。设备 session 由 CLI 自动登记或刷新；401 `agent_device_session_required` 仅续期并重试一次，仍失败时返回错误，不循环。

## Agent Type / Host

| Agent Type | 默认行为 |
|---|---|
| `codex-desktop` | 登记该类型并使用 `codex` Host instruction。 |
| `codex-cli` | 登记该类型并使用 terminal instruction。 |
| `claude-code-desktop` | 登记该类型并使用 `claude-code` Host instruction。 |
| `claude-code-cli` | 登记该类型并使用 terminal instruction。 |
| `workbuddy` | 登记该类型并使用 plain-chat instruction。 |
