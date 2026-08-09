# `itpay vault list`

## 语法

```bash
itpay vault list [--query <text>] [--limit <1..50>] [--cursor <cursor>] [--json]
```

只列出当前 Device + Agent Instance 在有效账号授权窗口内可发现的 Buyer Vault 摘要。CLI 不发送 Buyer ID，也不解密 payload。

## 成功 JSON

```json
{
  "status": "vault_listed",
  "result": {
    "items": [{
      "artifact_ref": "<ref>",
      "service_title": "<title>",
      "subject_label": "<subject>",
      "order_code": "<code>",
      "artifact_status": "<status>",
      "access_status": "<status>",
      "created_at": "<RFC3339>",
      "available_sections": ["<section>"]
    }],
    "next_cursor": null
  },
  "instruction": "让用户选择一个 artifact_ref；需要首次读取授权时运行 itpay vault access --artifact <artifact_ref> --json。",
  "next": null,
  "recovery": []
}
```

空列表使用 `status=no_vault_artifacts`，`items=[]`，不得猜测 artifact ID。

## 授权缺失

```json
{
  "status": "human_authorization_required",
  "result": null,
  "instruction": "打开一次官方 ItPay 授权链接并停止；用户在页面选择时长。",
  "next": { "command": "itpay vault access --json", "reason": "创建账号 Vault 授权请求" },
  "recovery": []
}
```

无效 limit/cursor 在 HTTP 前返回稳定错误。授权过期不自动重试、不创建新 Device。
