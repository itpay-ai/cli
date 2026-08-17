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

## 用户服务口径

- 先说明退款是否已提交、是否冻结交付、当前是自动路径还是人工审核，再给下一步。
- 未消费交付通常进入自动路径；已消费交付通常进入人工审核。这描述处理路线，不保证成功或到账时间。
- 只有 `refund_status=succeeded` 才能告诉用户退款成功。
- `outcome_unknown` 必须解释为需要渠道对账，禁止重复申请或重放。
- 不向用户倾倒 Provider、签名、网络或内部错误；不得把平台或渠道失败归咎于用户。

## 语法、参数与标准输出

```bash
itpay refund --order <order_id> [--reason <reason>] [--json]
itpay refund --help
```

兼容别名的参数、输出、instruction 和异常合同与 [`refund create`](create.md) 完全相同。无 `--order` 时只显示 help 和推荐的 `refund create` 语法，不发送请求。

## Agent Type / Host

所有正式支持的 Local Agent Type 使用同一签名 Device Authority 和退款状态机；Host 不影响退款资格。
