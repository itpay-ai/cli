# `itpay readyz`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The same entry point supports Buyer workflows and the existing `itpay sell` Seller workflow.

## 范围与意义

检查当前官方 Backend 是否可用。默认使用生产环境 `https://app.itpay.ai`；仅测试时可通过 `ITPAY_BACKEND_URL=https://sandbox.itpay.ai` 选择官方沙箱环境。它只调用 `/v1/readyz` 做 liveness 诊断，不执行平台兼容性 gate、不登记设备、不创建业务资源；需要服务端合同的命令仍会在各自入口严格检查 compatibility。

**上游：** CLI 安装；Backend 只能是官方 `https://app.itpay.ai` 或 `https://sandbox.itpay.ai`，其他 override 在网络或本地状态写入前被拒绝。
**下游：** 完整 `itpay` Skill；由 Agent 根据用户意图选择新服务、已购内容、订单或退款入口。

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
  "instruction": "ItPay 可用。先完整读取内置 Skill，再根据用户意图选择新服务、已购内容、订单或退款入口；不要默认开始购买。",
  "next": { "command": "itpay skill show itpay --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

沙箱环境返回同一 envelope，但明确标记环境并在每个后续命令中保留 sandbox Backend：

```json
{
  "status": "ready",
  "result": { "backend": "available", "backend_url": "https://sandbox.itpay.ai", "environment": "development" },
  "instruction": "ItPay sandbox 可用。先完整读取内置 Skill，再根据用户意图选择新服务、已购内容、订单或退款入口；后续必须执行返回的完整命令并保持同一 sandbox Backend。",
  "next": { "command": "ITPAY_BACKEND_URL=https://sandbox.itpay.ai itpay skill show itpay --json", "reason": "加载完整操作与安全规则" },
  "recovery": []
}
```

## 异常处理

已收到 Backend 不可用响应等非传输异常时返回 `backend_unavailable`。尚未收到完整 HTTP 响应的临时传输失败使用 conventions 中对应的稳定 `network_*` 错误码；`readyz` 是 GET，按全局安全传输合同最多自动重试两次。有限尝试结束后本轮检查未完成，next=null、recovery=[]；网络恢复后可以重新检查，不得在失败时切换环境或继续下单。

非官方 URL 返回 `backend_override_forbidden`，且不提供自动 recovery：

```json
{
  "status": "error",
  "error": {
    "code": "backend_override_forbidden",
    "message": "ITPAY_BACKEND_URL only supports https://app.itpay.ai or https://sandbox.itpay.ai"
  },
  "instruction": "移除 ITPAY_BACKEND_URL 使用正式环境，或准确设置为 https://sandbox.itpay.ai。",
  "next": null,
  "recovery": []
}
```

业务命令取得兼容性合同但不匹配时，返回 `backend_contract_incompatible`；readyz 本身只证明存活。输出保留 `current_cli_version`、`current_api_contract_revision`、`platform_api_contract_revision`、`minimum_cli_version`、`maximum_cli_major`。minimum 是协议门槛，不是推荐制品。所有分发渠道均停止本轮、next=null、recovery=[]，由维护方提供已核验的配套制品；不要猜版本、降级或改变身份。

## Agent Type / Host

本命令不渲染 Host 内容。若已声明 Agent Type，`result.agent_type` 会确认该类型，且返回的 Skill 命令保留同一 `--agent-type`；未声明时 Skill 会先引导 `install`。
