# `itpay docs`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 命令范围

浏览 npm 包内置的 Agent 操作文档。它是运行时自助说明，不读取服务端业务数据。

**上游：** CLI 安装。
**下游：** 选择并读取一个 topic。

## 子命令

- [`docs list`](list.md) - 列出 topic
- [`docs show`](show.md) - 显示完整 topic
- [`docs search`](search.md) - 按关键词查 topic

直接运行 `itpay docs` 只显示 help。

## 语法、输出与异常

```bash
itpay docs --help
```

输出三个子命令的一行用途，instruction 是先 `list` 或按关键词 `search`。未知子命令只返回参数错误和本 help，不读取文档目录。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 使用同一文档源；topic 内容可以包含各类型专属 section。
