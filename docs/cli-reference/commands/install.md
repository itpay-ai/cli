# `itpay install`

## 范围与意义

读取当前 CLI 内置的 Agent Type 安装合同。它只说明 npm 安装、默认 API、默认 Host 和下一条验证命令；不修改宿主配置、不登记设备，也不调用 Backend。

**上游：** 安装或更新 `@itpay/cli`。

**下游：** 使用真实 Agent Type 执行 `readyz`，随后读取 Catalog。

## 语法与参数

```bash
itpay install [target] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `target` | 否 | 五种正式 Agent Type 之一；省略或传 `list` 时列出全部。Host 名称不是合法 target。 |
| `--json` | 否 | 返回标准命令 envelope；推荐 Agent 使用。 |

正式 target：`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`。

## 指定 Agent Type 输出

```json
{
  "status": "instructions_ready",
  "result": {
    "agent_type": "codex-desktop",
    "default_host": "codex",
    "default_api": "https://app.itpay.ai",
    "install_command": "npm install -g @itpay/cli"
  },
  "instruction": "在 Codex Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "next": {
    "command": "itpay --agent-type codex-desktop readyz --json",
    "reason": "验证 CLI 与默认 ItPay API 的兼容性"
  },
  "recovery": [
    {
      "command": "itpay docs show install-and-setup",
      "reason": "查看环境覆盖和首次使用说明"
    }
  ]
}
```

`result` 是客观安装事实；`instruction` 只解释当前 Agent Type 的展示责任；`next` 只有一条可执行验证命令。

## 列表输出

省略 target 或传 `list` 时返回五组 `agent_type/default_host`，不重复每种类型的完整 instruction：

```json
{
  "status": "install_targets",
  "result": {
    "agent_types": [
      { "agent_type": "codex-desktop", "default_host": "codex" },
      { "agent_type": "codex-cli", "default_host": "terminal" },
      { "agent_type": "claude-code-desktop", "default_host": "claude-code" },
      { "agent_type": "claude-code-cli", "default_host": "terminal" },
      { "agent_type": "workbuddy", "default_host": "plain-chat" }
    ]
  },
  "instruction": "选择当前真实运行环境；同一 Agent 不要临时更换 Agent Type。",
  "next": null,
  "recovery": [
    {
      "command": "itpay docs show install-and-setup",
      "reason": "查看安装与环境说明"
    }
  ]
}
```

## Agent Type / Host

| Agent Type | 默认 Host | instruction 重点 |
| --- | --- | --- |
| `codex-desktop` | `codex` | 桌面对话必须实际展示二维码和付款链接。 |
| `codex-cli` | `terminal` | 只在用户可见终端展示付款交接。 |
| `claude-code-desktop` | `claude-code` | 桌面对话必须实际展示二维码和付款链接。 |
| `claude-code-cli` | `terminal` | 只在用户可见终端展示付款交接。 |
| `workbuddy` | `plain-chat` | 当前使用通用会话交接，必须发送链接和可用图片。 |

显式 `--host` 可以在后续 commerce 命令覆盖默认 Host，但不会改变 Agent Type 或设备归属。

## 异常处理

未知 target 返回：

```json
{
  "status": "error",
  "error": {
    "code": "unsupported_agent_type",
    "message": "unsupported install target: codex"
  },
  "instruction": "target 只接受：codex-desktop, codex-cli, claude-code-desktop, claude-code-cli, workbuddy。",
  "next": null,
  "recovery": [
    {
      "command": "itpay install --json",
      "reason": "列出正式支持的 Agent Type"
    }
  ]
}
```

错误不会写入本地状态。不要把 `codex`、`terminal` 或 `claude-code` 等 Host 名称当成 Agent Type。
