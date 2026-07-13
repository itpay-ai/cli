# `itpay readyz`

## 范围与意义

检查当前配置的 ItPay API 是否可用。它只做环境诊断，不登记设备、不创建业务资源。

**上游：** CLI 安装和 Backend URL 配置。
**下游：** `catalog list` 或失败后的网络/配置修复。

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
  "instruction": "ItPay 可用，可以读取服务目录。",
  "next": { "command": "itpay catalog list", "reason": "发现可用服务" },
  "recovery": []
}
```

## 异常处理

连接失败时返回 `backend_unavailable`，要求核对 `ITPAY_BACKEND_URL` 后重试同一命令，不得继续下单。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 行为相同；本命令不渲染 Host 内容。

