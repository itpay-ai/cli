# `itpay device recover`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围

仅在运营明确确认当前 Backend 的 Device 登记数据库已重建或清空后，删除本地该 Backend 的 v2 registration：

```bash
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
```

命令只作用于固定生产后端 `https://app.itpay.ai` 的 Device registration，并保留本地 Ed25519 私钥、Cart 和业务资源。CLI 不接受 Backend URL 覆盖。该命令不访问 Backend、不自动创建新身份；返回的只读 `services list` 是重新登记入口。

缺少确认参数返回 `backend_reset_confirmation_required`。普通 session 失效由 CLI 自动续期；revoked、quota、权限或未知 Backend 故障不得使用本命令。所有 Agent Type 使用相同输入和输出合同。
