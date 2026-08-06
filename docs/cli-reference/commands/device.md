# `itpay device` / `itpay device recover`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围

`itpay device` 只显示该命令组的帮助并退出，不访问 Backend、不读取或修改身份。当前唯一子命令是 `recover`。

仅在运营明确确认当前 Backend 的 Device 登记数据库已重建或清空后，删除本地该 Backend 的 v2 registration：

```bash
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
```

命令只作用于当前官方 Backend 的 Device registration，并保留本地 Ed25519 私钥、Cart 和业务资源。默认是 `https://app.itpay.ai`；显式测试可使用准确的 `ITPAY_BACKEND_URL=https://dev.itpay.ai`。该命令不访问 Backend、不自动创建新身份；返回的只读 `services list` 会保留同一 Backend，是重新登记入口。

缺少确认参数返回 `backend_reset_confirmation_required`。普通 session 失效由 CLI 自动续期；revoked、quota、权限或未知 Backend 故障不得使用本命令。所有 Agent Type 使用相同输入和输出合同。

## 参数

| 参数 | 必填 | 说明 |
|---|---:|---|
| 全局 `--agent-type <agent_type>` | 是 | 当前真实且稳定的 Agent Type；必须位于 `device` 前。 |
| `--confirm-backend-reset` | 是 | 确认运营已明确判定所选 Backend 的登记数据库被重建或清空。 |
| `--json` | 否 | 输出稳定 JSON 信封；否则输出同一事实的简洁文本。 |

## 标准输出

```json
{
  "status": "backend_registration_removed",
  "result": {
    "backend": "https://app.itpay.ai",
    "removed_agent_types": ["codex-desktop"],
    "private_key_preserved": true,
    "other_backend_registrations_preserved": true
  },
  "instruction": "只读列出 Service Executions，以同一私钥和 Agent Type 重新登记当前 Backend；不要删除 ~/.itpay-v3 或切换运行时。",
  "next": {
    "command": "itpay --agent-type codex-desktop services list --limit 1 --json",
    "reason": "用无业务写入的签名请求重新登记当前 Backend"
  },
  "recovery": []
}
```

当前 Backend 已无本地登记时，`status` 为 `backend_registration_absent`、`removed_agent_types=[]`，其余合同不变。文本输出只包含 Backend、registration 状态、私钥保留和其他 Backend 保留四项，不输出私钥、公钥、Device ID、Agent Instance ID、session、token 或本地文件内容。

缺少 Agent Type 返回 `agent_type_required`；缺少确认返回 `backend_reset_confirmation_required`。其他本地恢复失败返回 `device_recovery_failed`。所有失败都必须发生在删除 registration 前；本命令不得删除整把 Device identity、Cart、operation journal 或其他 Backend 登记。
