# `itpay vault`

使用当前 Local Device + Agent Instance 查看同一 Buyer 已购买并保存到 ItPay Vault 的内容。命令不接收 Buyer token，不与 MCP OAuth token混用，也不创建购买、支付或退款。

```bash
itpay vault list
itpay vault access [--artifact <artifact_ref>]
itpay vault read --artifact <artifact_ref> [--section <name>...]
```

第一次使用或授权窗口过期时，先运行 `vault access`，由用户在 ItPay 页面登录并选择授权时长。
