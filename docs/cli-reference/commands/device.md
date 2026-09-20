# `itpay device` / `itpay device recover`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围

`itpay device` 只显示该命令组的帮助并退出，不访问 Backend、不读取或修改身份。当前子命令是 `recover`（运营确认 Backend 重置后删除本地登记）和 `reset-key`（服务端拒绝当前私钥登记时放弃本地密钥）。

仅在运营明确确认当前 Backend 的 Device 登记数据库已重建或清空后，删除本地该 Backend 的 v2 registration：

```bash
itpay --agent-type <agent_type> device recover --confirm-backend-reset --json
```

命令只作用于当前官方 Backend 的 Device registration，并保留本地 Ed25519 私钥、Cart 和业务资源。默认是 `https://app.itpay.ai`；显式测试可使用准确的 `ITPAY_BACKEND_URL=https://sandbox.itpay.ai`。该命令不访问 Backend、不自动创建新身份；返回的只读 `services list` 会保留同一 Backend，是重新登记入口。

同一台电脑上的多个 Local Agent Type 共享本地 Device key，但各自使用独立 Agent
Instance。CLI 只在原子更新 Device state 时使用短期本地锁；释放和 stale recovery
通过 rename 完成，不依赖 Host 删除文件，因此 WorkBuddy 等 sandbox 的
safe-delete/trash shim 不应阻断正常命令。该锁不在 Backend，不会让另一台电脑或
另一个 Buyer 等待。遇到本地锁错误时不得删除 `~/.itpay-v3/device`、切换 Agent
Type 或执行 `device recover`；应保留身份并重试原命令一次，持续失败时报告
`device_state_unwritable` 或 lock timeout。

缺少确认参数返回 `backend_reset_confirmation_required`。普通 session 失效由 CLI 自动续期；revoked、quota、权限或未知 Backend 故障不得使用本命令。所有 Agent Type 使用相同输入和输出合同。

## `itpay device reset-key`

仅在服务端拒绝以当前私钥完成设备登记时使用（登记阶段持续返回 `internal_error`，或返回 `agent_device_key_rotated` / `agent_device_key_conflict`）。这是本地操作，不访问 Backend：

```bash
itpay device reset-key --confirm-key-reset --json
```

命令删除本地 Ed25519 私钥并清空所有 Backend 的本地登记记录；下一次需要设备身份的命令会以全新密钥重新登记为新设备。服务端旧设备记录保留为孤儿，不会被删除或复用；原设备的额度谱系不迁移。先尝试普通重试——Backend 会把已验证私钥的重复登记幂等挂回原设备，只有在该修复不可用或私钥已被服务端轮换/冲突时才需要本命令。

缺少确认参数返回 `key_reset_confirmation_required`；本地文件操作失败返回 `device_key_reset_failed`。本命令不得删除 Cart、operation journal 或 `~/.itpay-v3` 的其他内容。

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
