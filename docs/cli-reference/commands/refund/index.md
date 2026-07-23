# `itpay refund`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 命令范围

创建、恢复、跟踪和取消退款申请。Refund Owner 决定政策和状态；CLI 只提交用户意图并展示服务端事实。

**上游：** 已归属当前 Buyer/Agent 的订单。
**下游：** 自动退款执行、Admin review、取消或终态。

## 子命令

- [`refund create`](create.md)
- [`refund list`](list.md)
- [`refund get`](get.md)
- [`refund watch`](watch.md)
- [`refund cancel`](cancel.md)

兼容别名 `itpay refund --order <id>` 等价于 `refund create`，文档和 instruction 统一推荐子命令形式。

退款创建成功即锁定对应交付；旧 Agent grant 不得继续读取。直接运行无参数 `itpay refund` 显示 help，不创建请求。

## 语法、参数与标准输出

```bash
itpay refund --order <order_id> [--reason <reason>] [--json]
itpay refund --help
```

兼容别名的参数、输出、instruction 和异常合同与 [`refund create`](create.md) 完全相同。无 `--order` 时只显示 help 和推荐的 `refund create` 语法，不发送请求。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`kimi-code`、`openclaw` 七种类型使用同一签名 Device Authority 和退款状态机；Host 不影响退款资格。
