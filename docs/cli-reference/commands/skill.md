# `itpay skill` / `itpay skill show`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取 npm 包内置的完整 ItPay Agent Skill。与按 topic 渐进读取的 `docs` 不同，本命令故意一次返回完整 `SKILL.md`，用于首次 onboarding 和身份/session 规则恢复；不访问 Backend，不修改宿主配置或本地身份。

`itpay skill` 只显示该命令组的帮助并退出，不读取 Skill 内容。

```bash
itpay [--agent-type <agent_type>] skill show itpay [--json]
```

当前只内置 `itpay`。该 Skill 是 Buyer 与未来 Seller 的共同入口，不再按角色拆分名称。`--json` 时完整 Markdown 位于 `result.content`；文本模式直接输出完整内容。

```json
{
  "status": "shown",
  "result": { "skill": "itpay", "content": "<complete_packaged_SKILL.md>" },
  "instruction": "完整读取并遵守 Skill；先如实选择当前运行环境对应的 Agent Type。",
  "next": { "command": "itpay install --json", "reason": "选择真实且稳定的 Agent Type" },
  "recovery": []
}
```

已声明 Agent Type 时 instruction 确认规范类型，`next.command` 保留该类型并指向 `catalog list --json`。除完整已发布 Skill 内容外，不得附加本地路径、安装目录、环境变量、Device 状态或 Backend 数据。

未声明 Agent Type 时，`next` 是 `itpay install --json`。已声明时，`next` 是保留同一类型的 `catalog list --json`。未知名称返回 `skill_not_found`；包内文件缺失或损坏返回 `skill_unavailable` 并要求重装同版本 CLI。

Skill 是操作和安全合同，不是服务端业务状态。执行时仍以每个命令当前 envelope 的 `result`、`instruction` 和 `next` 为准。

所有 Agent Type 使用相同的 JSON 外壳、字段和命令参数。`workbuddy` 只在 `instruction` 中额外要求：写入 `~/.itpay-v3` 前把 Shell 工具参数 `dangerouslyDisableSandbox` 设为 `true`；权限被拒绝时停止，不切换 Node、不删除 identity、不处理 lock。它不改变输入或输出 schema。
