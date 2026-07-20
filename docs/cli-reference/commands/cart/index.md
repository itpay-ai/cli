# `itpay cart`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 命令范围

管理 canonical server Cart。Catalog line 可以创建 Service Execution；已准备好的 Service Quote 则通过 `cart add --quote` 加入 Cart。Cart 聚合交易，但不合并 Execution、候选归属或交付。

**上游：** Catalog item、variant、offer 和服务输入。
**下游：** Service Execution、Quote 聚合或 `buy`。

## 子命令

- [`cart add`](add.md)
- [`cart next`](next.md)
- [`cart remove`](remove.md)
- [`cart show`](show.md)
- [`cart clear`](clear.md)

`--local` 只用于显式本地草稿兼容，不得用于 service-backed flow。直接运行 `itpay cart` 显示 help。

## 语法、输出与异常

```bash
itpay cart --help
```

输出五个子命令及 canonical server cart 的说明，instruction 是未知状态先运行 `cart next`。未知子命令返回参数错误；不得因此清理本地 cart。

## Agent Type / Host

Cart 事实在 `codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 下相同；`add` 创建 client context 时记录真实 Agent Type 和 Host。
