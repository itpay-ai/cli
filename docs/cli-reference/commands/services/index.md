# `itpay services`

## 命令范围

操作通用 Service Execution。CLI 不知道某个服务的业务流程；它读取服务合同中的 capability、input schema、价格、交付模式和服务端 next action。

**上游：** Catalog 的 `service_id`。
**下游：** 免费能力、人工动作、付费 Checkout、Agent-visible 交付或 Vault 授权交付。

## 核心不变量

- 一个 execution 表示一次明确服务意图；是否可复用由服务端 graph 决定，CLI 不自行假设。
- 任何 capability 输入都必须在状态写入、锁价、订单创建和 Provider 调用前通过 schema 校验。
- `invoke` 只运行当前阶段允许且不需付款的 Agent-visible capability。
- 付费 capability 使用 `services checkout`，输入锁入 quote。
- `agent_visible_result` 从 `services next` 读取；`vault_artifact` 只有人授权后才能 `read-result`。

## 子命令

- [`start`](start.md)
- [`invoke`](invoke.md)
- [`action`](action.md)
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

输出九个子命令及一句选择规则：正常推进使用 `next`，深度诊断才使用 `get/events`。未知子命令返回参数错误和本 help，不创建 execution。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 共享状态机；Agent Type 只影响身份归属和 Host instruction，不允许影响 quota 规则或服务能力。
