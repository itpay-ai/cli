# `itpay readyz`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

检查固定生产 Backend `https://app.itpay.ai` 是否可用。它只调用 `/v1/readyz` 做 liveness 诊断，不执行平台兼容性 gate、不登记设备、不创建业务资源；需要服务端合同的命令仍会在各自入口严格检查 compatibility。

**上游：** CLI 安装；Backend 固定为 `https://app.itpay.ai`，不可由运行时环境覆盖。
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
  "result": { "backend": "available" },
  "instruction": "ItPay 可用；先完整读取内置 ItPay Skill，再进入当前已支持的 buy 流程。sell 将来也使用同一入口，但当前尚未实现。",
  "next": { "command": "itpay skill show itpay --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

## 异常处理

连接失败时返回 `backend_unavailable`，要求等待 `https://app.itpay.ai` 恢复后重试同一命令，不得切换后端或继续下单。

## Agent Type / Host

本命令不渲染 Host 内容。若已声明 Agent Type，`result.agent_type` 会确认该类型，且返回的 Skill 命令保留同一 `--agent-type`；未声明时 Skill 会先引导 `install`。
