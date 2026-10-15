# `itpay refund`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

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

普通退款统一使用 `refund create` 子命令；铁路退款／改签使用原订单返回的 aftercare 完整模板。

退款创建成功即锁定对应交付；旧 Agent grant 不得继续读取。直接运行无参数 `itpay refund` 显示 help，不创建请求。

## 用户服务口径

- 先说明退款是否已提交、是否冻结交付、当前是自动路径还是人工审核，再给下一步。
- 未消费交付通常进入自动路径；已消费交付通常进入人工审核。这描述处理路线，不保证成功或到账时间。
- 只有 `refund_status=succeeded` 才能告诉用户退款成功。
- `outcome_unknown` 必须解释为需要渠道对账，禁止重复申请或重放。
- 不向用户倾倒 Provider、签名、网络或内部错误；不得把平台或渠道失败归咎于用户。

## 语法、参数与标准输出

```bash
itpay refund create --order <order_id> [--reason <reason>] [--json]
itpay refund --help
```

创建参数与边界见 refund create；无参数的分组只显示help，不发送请求。

## Agent Type / Host

所有正式支持的 Local Agent Type 使用同一签名 Device Authority 和退款状态机；Host 不影响退款资格。
