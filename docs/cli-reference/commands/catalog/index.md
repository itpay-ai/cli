# `itpay catalog`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 命令范围

读取已发布的服务目录，帮助 Agent 发现可启动的通用服务。Catalog 只描述产品和入口，不执行服务、不创建购物车。

**上游：** `readyz`。
**下游：** [`catalog list`](list.md)，然后按目录中的 `service_id` 使用 `services start`。

## 子命令

- [`itpay catalog list`](list.md) - 列出当前已发布服务、用途、辅助能力、主服务和价格。

直接运行 `itpay catalog` 时显示本页等价的简短 help，不请求 API。

## 语法、输出与异常

```bash
itpay catalog --help
```

直接运行时输出子命令、用途和 `catalog list` 示例，instruction 是选择 `list`；不返回 Catalog 内容。未知子命令返回 Commander 参数错误和 `itpay catalog --help` recovery。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种支持类型的目录事实完全相同。instruction 可按 Agent Type 调整措辞，但不得改变服务排序、价格或可用能力。
