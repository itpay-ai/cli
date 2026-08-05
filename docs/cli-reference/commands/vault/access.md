# `itpay vault access`

## 范围与意义

为当前 exact Agent Instance 创建 Vault 访问请求，返回人类授权 URL。不解密，不调用 Provider。

## 语法与参数

```bash
itpay vault access --artifact <artifact_ref> [--field <path>...] [--json]
```

| 参数 | 说明 |
|---|---|
| `--artifact` | 必填，`vault list` 返回的 `artifact_ref`。 |
| `--field` | 可选，可重复；默认使用 artifact 允许字段。 |

## 标准输出

```json
{
  "status": "human_authorization_required",
  "result": {
    "access_request_id": "var_...",
    "expires_at": "<RFC3339>",
    "authorization": {
      "url": "https://app.itpay.ai/vault/access/var_...?start_token=...",
      "qr_png_url": "https://app.itpay.ai/v1/vault/access-requests/var_.../qr.png?start_token=...",
      "mobile_direct": true
    },
    "artifact_ref": "va_..."
  },
  "handoff": {
    "url": "https://app.itpay.ai/vault/access/var_...?start_token=..."
  },
  "instruction": "请用户在浏览器以同一 Buyer 登录并批准；批准后执行 vault read。不要记录或复制 start_token。",
  "next": { "command": "itpay vault read --artifact va_... --json", "reason": "批准后读取受保护结果" },
  "recovery": []
}
```

## 异常

- `authorization_required` / ownership：不要改用其他 artifact 猜测。
- 不要把 Buyer/Device/Connection ID 作为参数传入。
