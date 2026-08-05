# `itpay vault list`

## 范围与意义

列出当前 Buyer 绑定 Local Agent 可见的 Vault 库存摘要（脱敏）。不解密，不调用 Provider。

**上游：** Device Authority 已绑定 Buyer。
**下游：** `vault access --artifact <artifact_ref>`。

## 语法与参数

```bash
itpay vault list [--query <text>] [--limit <n>] [--json]
```

| 参数 | 默认 | 说明 |
|---|---:|---|
| `--query` | 空 | 匹配 order code / service title / subject label。 |
| `--limit` | `20` | 最大 50。 |
| `--json` | 否 | 标准 JSON envelope。 |

## 标准输出

```json
{
  "status": "vault_listed",
  "result": {
    "items": [
      {
        "artifact_ref": "va_...",
        "service_title": "企知道企业综合报告",
        "subject_label": "京东",
        "order_code": "IP-12345678",
        "access_status": "approval_required",
        "amount_minor": 200,
        "currency": "CNY"
      }
    ],
    "next_cursor": null
  },
  "instruction": "让用户选择 artifact_ref 后请求授权；不要假设第一项就是当前任务。",
  "next": { "command": "itpay vault access --artifact va_... --json", "reason": "请求人类授权" },
  "recovery": []
}
```

## 异常

- 未绑定 Buyer：`agent_access_denied` / ownership 错误；不要猜测 Buyer ID。
- 购买请求应使用现有 commerce 命令，不要通过 MCP 或本命令创建支付。
