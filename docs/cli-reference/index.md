# ItPay CLI Command Reference

本目录是 ItPay CLI 的规范性命令合同。它定义命令应向人和 Agent 返回什么、如何指导下一步，以及失败后如何恢复。当前实现与本文档不一致时，以本文档作为后续校准目标。

企知道可以作为示例数据出现，但任何命令、字段、状态和 instruction 都不得依赖某个服务。服务差异只能来自 Catalog、Service Contract、Capability metadata 和服务端状态。

## 使用约定

- [输出与错误合同](conventions.md)
- [Agent Type 与 Host](agent-types.md)
- 所有示例中的 `<...>` 都是占位符，不得原样提交。
- 所有 commerce 命令必须使用真实的 `--agent-type`，不得为刷新额度伪造类型。
- 每条命令只返回当前步骤所需事实、一条 instruction、一个首选 next；异常时最多返回两个 recovery。

## 命令目录

### 环境与发现

- [`itpay readyz`](commands/readyz.md) - 检查后端是否可用
- [`itpay next`](commands/next.md) - 从本地保存的服务端句柄恢复下一步
- [`itpay catalog`](commands/catalog/index.md)
  - [`itpay catalog list`](commands/catalog/list.md)
- [`itpay install`](commands/install.md) - 查看指定 Agent 的安装说明
- [`itpay docs`](commands/docs/index.md)
  - [`itpay docs list`](commands/docs/list.md)
  - [`itpay docs show`](commands/docs/show.md)
  - [`itpay docs search`](commands/docs/search.md)

### 购物与支付

- [`itpay cart`](commands/cart/index.md)
  - [`itpay cart add`](commands/cart/add.md)
  - [`itpay cart next`](commands/cart/next.md)
  - [`itpay cart remove`](commands/cart/remove.md)
  - [`itpay cart show`](commands/cart/show.md)
  - [`itpay cart clear`](commands/cart/clear.md)
- [`itpay buy`](commands/buy.md)
- [`itpay checkout`](commands/checkout.md)
- [`itpay pay`](commands/pay.md)
- [`itpay order`](commands/order.md)
- [`itpay orders`](commands/orders.md)

### 退款

- [`itpay refund`](commands/refund/index.md)
  - [`itpay refund create`](commands/refund/create.md)
  - [`itpay refund list`](commands/refund/list.md)
  - [`itpay refund get`](commands/refund/get.md)
  - [`itpay refund watch`](commands/refund/watch.md)
  - [`itpay refund cancel`](commands/refund/cancel.md)

### 通用服务执行

- [`itpay services`](commands/services/index.md)
  - [`itpay services start`](commands/services/start.md)
  - [`itpay services invoke`](commands/services/invoke.md)
  - [`itpay services action`](commands/services/action.md)
  - [`itpay services checkout`](commands/services/checkout.md)
  - [`itpay services list`](commands/services/list.md)
  - [`itpay services get`](commands/services/get.md)
  - [`itpay services next`](commands/services/next.md)
  - [`itpay services read-result`](commands/services/read-result.md)
  - [`itpay services events`](commands/services/events.md)

