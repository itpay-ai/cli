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

## Agent Type / Host

本命令不渲染 Host 内容。若已声明 Agent Type，`result.agent_type` 会确认该类型，且返回的 Skill 命令保留同一 `--agent-type`；未声明时 Skill 会先引导 `install`。
