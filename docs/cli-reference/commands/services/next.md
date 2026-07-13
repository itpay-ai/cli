# `itpay services next`

## 范围与意义

读取一笔 Service Execution 的当前状态，并只返回一个首选下一步。若交付模式允许 Agent 直接读取，本命令同时返回完整 safe result。

**上游：** `services start`、`invoke`、`action`、`checkout`，或一次中断恢复。  
**下游：** 一个可执行命令、需要用户完成的授权，或流程结束。

本命令不返回原始 Backend DTO、capability 列表、内部 result ID/hash、graph、binding 或重复 guidance。

## 语法与参数

```bash
itpay services next <service_execution_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `service_execution_id` | 是 | `services start` 或后续命令返回的 execution ID。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

需要有效 Agent Device session。命令不接受 Buyer token、capability 或服务输入。

## Agent-visible 结果

```json
{
  "status": "result_ready",
  "result": {
    "service_execution_id": "<id>",
    "delivery_mode": "agent_visible_result",
    "items": [
      {
        "rank": 1,
        "title": "<title>",
        "safe_payload": { "<public_field>": "<value>" }
      }
    ]
  },
  "instruction": "结果已可供 Agent 使用；只使用 safe_payload，不调用 read-result。",
  "next": null,
  "recovery": []
}
```

文本输出依次显示 `status`、execution、`delivery_mode`、候选及 instruction。它不会建议 `read-result`。

## Vault 交付

未授权时不返回 result item 或 protected payload：

```json
{
  "status": "human_authorization_required",
  "result": {
    "service_execution_id": "<id>",
    "delivery_mode": "vault_artifact",
    "grant_status": "none"
  },
  "instruction": "请用户在订单页面授权；未授权前不要读取、猜测或声称已看到内容。",
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
    "delivery_mode": "vault_artifact",
    "grant_status": "active",
    "grant_expires_at": "<RFC3339 time>"
  },
  "instruction": "用户授权当前有效；立即读取一次受保护结果，并遵守返回的字段范围与到期时间。",
  "next": {
    "command": "itpay services read-result <id> --json",
    "reason": "读取当前有效 grant 的结果"
  },
  "recovery": []
}
```

其他执行阶段只返回 execution、service、phase、`next_action` 和一个服务端状态导出的命令。完成或空结果后不得建议重放已失效的 invoke。

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
