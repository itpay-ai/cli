# `itpay vault access`

## 语法

```bash
itpay vault access [--artifact <artifact_ref>] [--json]
```

- 无 `--artifact`：请求当前 Device + Agent Instance 的账号 Vault 窗口。
- 有 `--artifact`：请求该内容的首次/敏感读取授权；必须已经有账号窗口。
- CLI 不接受时长、Buyer ID、回调 URL、MCP Connection ID 或 start token 参数。

## 标准 JSON

```json
{
  "status": "human_authorization_required",
  "result": {
    "request_id": "<id>",
    "purpose": "account_window",
    "artifact_ref": null,
    "request_expires_at": "<RFC3339>",
    "authorization_url": "https://app.itpay.ai/vault/access/...",
    "qr_png_url": "https://app.itpay.ai/v1/vault/access-requests/.../qr.png"
  },
  "instruction": "直接打开官方 authorization_url（桌面可展示 qr_png_url），然后停止等待用户；不要重复创建请求。",
  "next": null,
  "recovery": []
}
```

同一 pending request 会返回同一 request_id 并轮换 start token；旧链接立即失效。终态请求不复用。
