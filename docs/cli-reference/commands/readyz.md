# `itpay readyz`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

检查当前官方 Backend 是否可用。默认使用生产环境 `https://app.itpay.ai`；仅测试时可通过 `ITPAY_BACKEND_URL=https://dev.itpay.ai` 选择官方开发环境。它只调用 `/v1/readyz` 做 liveness 诊断，不执行平台兼容性 gate、不登记设备、不创建业务资源；需要服务端合同的命令仍会在各自入口严格检查 compatibility。

**上游：** CLI 安装；Backend 只能是官方 `https://app.itpay.ai` 或 `https://dev.itpay.ai`，其他 override 在网络或本地状态写入前被拒绝。
**下游：** 完整 `itpay` Skill，随后选择 Agent Type 或进入当前已支持的 Buyer Catalog。

## 语法与参数

```bash
itpay readyz [--json]
```

| 参数 | 必填 | 说明 |
|---|---:|---|
| `--json` | 否 | 返回标准 JSON。 |

## 标准输出

```json
{
  "status": "ready",
  "result": { "backend": "available", "backend_url": "https://app.itpay.ai", "environment": "production" },
  "instruction": "ItPay 可用；先完整读取内置 ItPay Skill，再进入当前已支持的 buy 流程。sell 将来也使用同一入口，但当前尚未实现。",
  "next": { "command": "itpay skill show itpay --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

开发环境返回同一 envelope，但明确标记环境并在每个后续命令中保留 dev Backend：

```json
{
  "status": "ready",
  "result": { "backend": "available", "backend_url": "https://dev.itpay.ai", "environment": "development" },
  "instruction": "ItPay dev 可用；后续必须执行返回的完整命令，并继续使用同一个 dev Backend。先完整读取内置 ItPay Skill，再进入当前已支持的 buy 流程。",
  "next": { "command": "ITPAY_BACKEND_URL=https://dev.itpay.ai itpay skill show itpay --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

## 异常处理

连接失败时返回 `backend_unavailable`，要求等待当前官方 Backend 恢复后重试同一完整命令，不得在失败时切换环境或继续下单。

非官方 URL 返回 `backend_override_forbidden`，且不提供自动 recovery：

```json
{
  "status": "error",
  "error": {
    "code": "backend_override_forbidden",
    "message": "ITPAY_BACKEND_URL only supports https://app.itpay.ai or https://dev.itpay.ai"
  },
  "instruction": "移除 ITPAY_BACKEND_URL 使用正式环境，或准确设置为 https://dev.itpay.ai。",
  "next": null,
  "recovery": []
}
```

CLI 已取得 Backend 的兼容性合同、但当前版本或 contract hash 不匹配时，返回一个可执行且版本固定的分发专属恢复动作。npm CLI 示例：

```json
{
  "status": "error",
  "error": {
    "code": "backend_contract_incompatible",
    "message": "CLI 2.0.15 contract sha256:client is incompatible with platform v3.example contract sha256:server (minimum CLI 2.0.16, maximum major 2)"
  },
  "result": {
    "current_cli_version": "2.0.15",
    "required_cli_version": "2.0.16"
  },
  "instruction": "当前 CLI 与 Backend 合约不兼容。停止所有 ItPay 业务命令；只执行 recovery.command，将 @itpay/cli 更新到 Backend 指定的精确版本。安装完成后确认 itpay --version 与 result.required_cli_version 完全一致，再重新运行 readyz。不要安装 latest、猜测版本、切换 Agent Type 或删除 Device 身份。",
  "next": null,
  "recovery": [
    {
      "command": "npm install -g @itpay/cli@2.0.16",
      "reason": "安装 Backend 指定的兼容 CLI 版本"
    }
  ]
}
```

OpenClaw bundle 的同一错误改为：

```json
{
  "status": "error",
  "error": {
    "code": "backend_contract_incompatible",
    "message": "<same compatibility fact>"
  },
  "result": {
    "current_cli_version": "2.0.15",
    "required_cli_version": "2.0.16"
  },
  "instruction": "当前 OpenClaw Skill bundle 与 Backend 合约不兼容。停止所有 ItPay 业务命令；只执行 recovery.command，更新 Skill 后启动新会话并确认 itpay --version 与 result.required_cli_version 完全一致，再重新运行 readyz。不要运行 npm、切换 Agent Type 或删除 Device 身份。",
  "next": null,
  "recovery": [
    {
      "command": "openclaw skills update itpay",
      "reason": "更新包含 Backend 指定 CLI 版本的 ItPay Skill bundle"
    }
  ]
}
```

Kimi bundle 使用其 plugin 更新入口，不返回 npm 命令。只允许使用 Backend 返回的 `minimum_cli_version` 生成精确版本要求；兼容性合同不可用、缺少合法版本或仅有无法验证的错误文本时，仍须停止且不得猜测安装版本。

## Agent Type / Host

本命令不渲染 Host 内容。若已声明 Agent Type，`result.agent_type` 会确认该类型，且返回的 Skill 命令保留同一 `--agent-type`；未声明时 Skill 会先引导 `install`。
