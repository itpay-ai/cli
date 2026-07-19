# `itpay skill show`

## 范围与意义

读取 npm 包内置的完整 Agent Skill。与按 topic 渐进读取的 `docs` 不同，本命令故意一次返回完整 `SKILL.md`，用于首次 onboarding 和身份/session 规则恢复；不访问 Backend，不修改宿主配置或本地身份。

```bash
itpay [--agent-type <agent_type>] skill show itpay-buyer [--json]
```

当前只内置 `itpay-buyer`。`--json` 时完整 Markdown 位于 `result.content`；文本模式直接输出完整内容。

未声明 Agent Type 时，`next` 是 `itpay install --json`。已声明时，`next` 是保留同一类型的 `catalog list --json`。未知名称返回 `skill_not_found`；包内文件缺失或损坏返回 `skill_unavailable` 并要求重装同版本 CLI。

Skill 是操作和安全合同，不是服务端业务状态。执行时仍以每个命令当前 envelope 的 `result`、`instruction` 和 `next` 为准。

所有 Agent Type 使用相同的 JSON 外壳、字段和命令参数。`workbuddy` 只在 `instruction` 中额外要求：写入 `~/.itpay-v3` 前把 Shell 工具参数 `dangerouslyDisableSandbox` 设为 `true`；权限被拒绝时停止，不切换 Node、不删除 identity、不处理 lock。它不改变输入或输出 schema。
