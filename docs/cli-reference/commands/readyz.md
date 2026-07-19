# `itpay readyz`

## 范围与意义

检查当前配置的 ItPay API 是否可用。它只做环境诊断，不登记设备、不创建业务资源。

**上游：** CLI 安装和 Backend URL 配置。
**下游：** 完整 `itpay-buyer` Skill，随后选择 Agent Type 或读取 Catalog。

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
  "result": { "backend": "available" },
  "instruction": "ItPay 可用；先完整读取内置 Buyer Skill，再开始服务流程。",
  "next": { "command": "itpay skill show itpay-buyer --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

## 异常处理

连接失败时返回 `backend_unavailable`，要求核对 `ITPAY_BACKEND_URL` 后重试同一命令，不得继续下单。

CLI 已取得 Backend 的兼容性合同、但当前版本或 contract hash 不匹配时，返回一个可执行且版本固定的恢复动作：

```json
{
  "status": "error",
  "error": {
    "code": "backend_contract_incompatible",
    "message": "CLI 2.0.13 contract sha256:client is incompatible with platform v3.example contract sha256:server (minimum CLI 2.0.14, maximum major 2)"
  },
  "result": {
    "current_cli_version": "2.0.13",
    "required_cli_version": "2.0.14"
  },
  "instruction": "当前 CLI 与 Backend 合约不兼容。停止所有 ItPay 业务命令；只执行 recovery.command，将 @itpay/cli 更新到 Backend 指定的精确版本。安装完成后确认 itpay --version 与 result.required_cli_version 完全一致，再重新运行 readyz。不要安装 latest、猜测版本、切换 Agent Type 或删除 Device 身份。",
  "next": null,
  "recovery": [
    {
      "command": "npm install -g @itpay/cli@2.0.14",
      "reason": "安装 Backend 指定的兼容 CLI 版本"
    }
  ]
}
```

只允许使用 Backend 返回的 `minimum_cli_version` 生成精确 npm 版本。兼容性合同不可用、缺少合法版本或仅有无法验证的错误文本时，仍须停止且不得猜测安装版本。

## Agent Type / Host

本命令不渲染 Host 内容。若已声明 Agent Type，`result.agent_type` 会确认该类型，且返回的 Skill 命令保留同一 `--agent-type`；未声明时 Skill 会先引导 `install`。
