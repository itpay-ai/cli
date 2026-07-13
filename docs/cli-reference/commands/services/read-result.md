# `itpay services read-result`

## 范围与意义

使用当前 Agent Device Authority，在用户创建的有效、未过期且范围匹配的 grant 内读取 Vault 保护结果。它不适用于 `agent_visible_result`。

**上游：** `services next` 返回 `vault_artifact`，且用户已在订单页面授权。  
**下游：** Agent 仅在 grant scope 和 TTL 内使用返回字段；没有自动后续命令。

## 语法与参数

```bash
itpay services read-result <service_execution_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | Vault 交付对应的 execution ID。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

CLI 使用已登记设备的签名 session，不接受 Checkout token、Buyer token、`agent_device_id` 参数或开发者凭证。

## 标准输出

```json
{
  "status": "granted_result_ready",
  "result": {
    "service_execution_id": "<id>",
    "grant_expires_at": "<RFC3339 time>",
    "granted_fields": ["<field>"],
    "payload": { "<granted_field>": "<value>" }
  },
  "instruction": "只使用本次授权字段；授权过期后停止读取并重新请求用户同意。",
  "next": null,
  "recovery": []
}
```

文本输出显示相同的 execution、到期时间、字段名和 payload，不附带 Vault ID、grant ID 或原始 scope。

## 异常处理

Agent-visible delivery 在请求 Vault endpoint 前被拒绝：

```json
{
  "status": "error",
  "error": {
    "code": "wrong_delivery_mode",
    "message": "service execution <id> has an agent-visible result"
  },
  "instruction": "该交付不需要 Vault grant；直接读取 safe result，不要调用 read-result。",
  "next": null,
  "recovery": [
    {
      "command": "itpay services next <id> --json",
      "reason": "读取 Agent-visible safe result"
    }
  ]
}
```

退款访问锁会在请求结果 endpoint 前优先拒绝，并指向同一退款：

```json
{
  "status": "error",
  "error": {
    "code": "delivery_locked_by_refund",
    "message": "delivery is locked by refund <refund_id>"
  },
  "instruction": "退款访问锁已生效；不要 reveal、创建 grant 或读取交付结果。",
  "next": null,
  "recovery": [
    {
      "command": "itpay refund get <refund_id> --json",
      "reason": "读取退款权威状态"
    }
  ]
}
```

无 grant、过期、撤销或 wrong-scope 保留 Backend 的 `agent_access_denied`，并返回：

```json
{
  "status": "error",
  "error": {
    "code": "agent_access_denied",
    "message": "<server reason>"
  },
  "instruction": "请用户在订单页面重新授权；不要使用开发者权限绕过授权或退款锁。",
  "next": null,
  "recovery": [
    {
      "command": "itpay services next <id> --json",
      "reason": "检查交付模式和 grant 状态"
    }
  ]
}
```

一个 grant 只允许读取对应订单、execution、Agent instance 和批准字段。拒绝时不得改用数据库、Admin API 或新 Device ID 绕过。

## Agent Type / Host

同一 Buyer account 下已登记的 `codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 可按政策领取同一订单授权；每个类型仍需自己的有效 Device Authority。五种类型返回相同字段、TTL 和错误，不因 Host 扩大 grant scope。
