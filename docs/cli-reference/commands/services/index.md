# `itpay services`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Seller-published workflows enter the same Buyer execution, Checkout, delivery, and refund state machine as ItPay services.

## 命令范围

操作通用 Service Execution。CLI 不知道某个服务的业务流程；它读取服务合同中的 capability、input schema、价格、交付模式和服务端 next action。

**上游：** Catalog 的 `service_id`。
**下游：** 免费能力、人工动作、付费 Checkout、Agent-visible 交付或 Vault 授权交付。

## 核心不变量

- Execution 的边界由服务合同决定；铁路查询和购票使用不同 Execution，已有执行的等待与恢复保持原 ID。其他独立服务分别执行，其 Quote 可进入同一 Cart。
- 任何 capability 输入都必须在状态写入、锁价、订单创建和 Provider 调用前通过 schema 校验。
- `invoke` 只运行当前阶段允许且不需付款的 Agent-visible capability。
- 依赖候选的付费 capability 必须继续来源 Execution；`action --candidate` 不能跨 Execution 搬运候选。
- 普通已选服务使用 `services purchase` 读取完整确认、提交真实同意并交付官方页面；此操作不请求支付。
- `services quote`、`cart add --quote`、`buy --cart` 保留为用户明确要求多服务组合的高级路径；旧 `services checkout` 保留已有执行兼容。
- `agent_visible_result` 从 `services next` 读取；`vault_artifact` 只有人授权后才能 `read-result`。

## 子命令

- [`start`](start.md)
- [`run`](run.md)
- [`invoke`](invoke.md)
- [`action`](action.md)
- [`quote`](quote.md)
- [`purchase`](purchase.md)
- [`checkout`](checkout.md)
- [`list`](list.md)
- [`get`](get.md)
- [`next`](next.md)
- [`read-result`](read-result.md)
- [`events`](events.md)

直接运行 `itpay services` 显示 help。

## 语法、输出与异常

```bash
itpay services --help
```

输出当前子命令：运行已发布服务使用 `run`，查询推进使用 `next`，选定后的完整购买确认使用 `purchase`，深度诊断才使用 `get/events`。未知子命令返回参数错误和本 help，不创建 Execution。

## Agent Type / Host

所有正式支持的 Local Agent Type 共享状态机；Agent Type 只影响身份归属和 Host instruction，不允许影响 quota 规则或服务能力。
