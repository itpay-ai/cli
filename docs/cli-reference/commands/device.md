# `itpay device recover`

## 范围

仅在运营明确确认当前 Backend 的 Device 登记数据库已重建或清空后，删除本地该 Backend 的 v2 registration：

```bash
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
```

命令使用 `ITPAY_BACKEND_URL` 选择唯一作用域，保留本地 Ed25519 私钥、其他 Backend registrations、Cart 和业务资源。它不访问 Backend，不自动创建新身份；返回的只读 `services list` 是重新登记入口。

缺少确认参数返回 `backend_reset_confirmation_required`。普通 session 失效由 CLI 自动续期；revoked、quota、权限或未知 Backend 故障不得使用本命令。所有 Agent Type 使用相同输入和输出合同。
