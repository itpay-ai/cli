# `itpay install`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

读取当前 CLI 内置的 Agent Type 运行合同。它只说明默认 API、默认 Host 和下一条验证命令；不安装 CLI、不修改宿主配置、不登记设备，也不调用 Backend。

**上游：** 当前 npm CLI 或平台 bundle 已经可执行。

**下游：** 使用真实 Agent Type 执行 `setup`，再读取并启用同包 Skill。authenticated 或成功 login_required 才证明设备访问可用；后者仍未登录，不自动发起授权或业务。

## 语法与参数

```bash
itpay install [target] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `target` | 否 | 九种正式 Agent Type 之一；省略或传 `list` 时列出全部。Host 名称不是合法 target。 |
| `--json` | 否 | 返回标准命令 envelope；推荐 Agent 使用。 |

正式 target：`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`zcode`、`doubao-work`、`kimi-code`、`openclaw`。

## 指定 Agent Type 输出

```json
{
  "status": "instructions_ready",
  "result": {
    "agent_type": "codex-desktop",
    "default_host": "codex",
    "default_api": "https://app.itpay.ai"
  },
  "instruction": "在 Codex Desktop 中始终传这个 Agent Type；付款时把返回的二维码和链接实际展示到当前对话。",
  "next": {
    "command": "itpay --agent-type codex-desktop setup --json",
    "reason": "准备当前宿主并确认设备与账号状态"
  },
  "recovery": [
    {
      "command": "itpay docs show install-and-setup",
      "reason": "查看官方 Backend 和首次使用说明"
    }
  ]
}
```

`result` 是客观运行时事实；`instruction` 只解释当前 Agent Type 的展示责任；`next` 只有一条可执行验证命令。任何 target 都不得返回 npm 安装命令。

OpenClaw 额外明确没有默认入口：

```json
{
  "status": "instructions_ready",
  "result": {
    "agent_type": "openclaw",
    "default_host": null,
    "host_required": true,
    "native_hosts": ["telegram"],
    "default_api": "https://app.itpay.ai"
  },
  "instruction": "保持 openclaw Agent Type；每个展示命令都从当前可信会话上下文显式传 --host，IM 入口同时传 --target。Telegram 使用返回的原生 message action，其他入口展示标准二维码和付款链接。",
  "next": {
    "command": "itpay --agent-type openclaw setup --json",
    "reason": "准备当前宿主并确认设备与账号状态"
  },
  "recovery": [
    {
      "command": "itpay docs show install-and-setup",
      "reason": "查看官方 Backend 和首次使用说明"
    }
  ]
}
```

## 列表输出

省略 target 或传 `list` 时返回九组运行时定义，不重复每种类型的完整 instruction：

```json
{
  "status": "install_targets",
  "result": {
    "agent_types": [
      { "agent_type": "codex-desktop", "default_host": "codex" },
      { "agent_type": "codex-cli", "default_host": "terminal" },
      { "agent_type": "claude-code-desktop", "default_host": "claude-code" },
      { "agent_type": "claude-code-cli", "default_host": "terminal" },
      { "agent_type": "workbuddy", "default_host": "plain-chat" },
      { "agent_type": "zcode", "default_host": "plain-chat" },
      { "agent_type": "doubao-work", "default_host": "plain-chat" },
      { "agent_type": "kimi-code", "default_host": "terminal" },
      {
        "agent_type": "openclaw",
        "default_host": null,
        "host_required": true,
        "native_hosts": ["telegram"]
      }
    ]
  },
  "instruction": "识别当前真实运行平台，从 result.agent_types 选择对应 agent_type，并由 Agent 自行运行 itpay setup --agent-type <agent_type> --json；不要让用户运行命令，也不要临时更换 Agent Type。",
  "next": null,
  "recovery": [
    {
      "command": "itpay docs show install-and-setup",
      "reason": "查看安装与环境说明"
    }
  ]
}
```

`next` 保持为空，因为 CLI 不能替 Agent 猜测其宿主平台；Agent 必须自行完成这次选择并继续执行，不得把技术选择或命令转交给用户。

## 宿主与限制

使用当前真实 Agent Type；同类型窗口复用当前 Backend 下的同一实例。显式 host 只改变展示，不改变身份、业务或同意。正式 Skill 与 render-hosts 拥有当前可用展示指引；原生工具不可用时同轮展示原官方URL，不为了图片或按钮反复排障。

未知 target 或参数错误按实际返回修正；本命令不写身份。准备设备统一使用 setup，不把 install、readyz、auth status 串成重复初始化链。
