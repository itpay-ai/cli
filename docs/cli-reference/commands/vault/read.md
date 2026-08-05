# `itpay vault read`

## 范围与意义

在 exact Agent Instance 已获人类授权且 grant 有效时，读取 artifact 授权字段。

## 语法与参数

```bash
itpay vault read --artifact <artifact_ref> [--json]
```

## 标准输出

```json
{
  "status": "result_ready",
  "result": {
    "artifact_ref": "va_...",
    "grant_expires_at": "<RFC3339>",
    "result": {}
  },
  "instruction": "仅展示授权字段数据；不要据此发起支付或退款。",
  "next": null,
  "recovery": []
}
```

## 非成功状态

```json
{
  "status": "authorization_required",
  "result": { "artifact_ref": "va_..." },
  "instruction": "需要人类授权；先 vault access，再重试 read。",
  "next": { "command": "itpay vault access --artifact va_... --json", "reason": "请求人类授权" },
  "recovery": []
}
```

```json
{
  "status": "result_preparing",
  "result": { "artifact_ref": "va_..." },
  "instruction": "结果准备中；稍后重试 vault read，不要新建 Provider 调用。",
  "next": { "command": "itpay vault read --artifact va_... --json", "reason": "稍后重试读取" },
  "recovery": []
}
```

```json
{
  "status": "result_unavailable",
  "result": { "artifact_ref": "va_...", "reason": "refunded" },
  "instruction": "该结果不可读取；不要重试、重新授权或调用 Provider。",
  "next": null,
  "recovery": []
}
```
