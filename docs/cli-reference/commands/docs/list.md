# `itpay docs list`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

按稳定 topic 名称列出 npm 包内置的 Agent 文档，只返回标题和一句用途，不加载完整内容，也不访问 Backend。

**上游：** `install`，或 Agent 不确定应查看哪个流程。

**下游：** 选择一个 topic 后执行 `docs show <topic>`。

## 语法与参数

```bash
itpay docs list [--json]
```

`--json` 返回标准命令 envelope；无筛选、分页或网络参数。topic 按名称稳定升序排列。

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "topics": [
      {
        "topic": "<topic>",
        "title": "<title>",
        "purpose": "<one-line purpose>"
      }
    ]
  },
  "instruction": "选择与当前步骤最接近的一个 topic；不要一次加载全部文档。",
  "next": null,
  "recovery": []
}
```

列表不替 Agent 选择 topic，因此不返回含 placeholder 的假命令。选定后执行：

```bash
itpay docs show <topic> --json
```

## 异常处理

随包文档目录缺失、文件损坏或合同字段不完整时返回 `docs_unavailable`，不暴露本地包路径；recovery 固定为重新安装当前 CLI 版本。

## Agent Type / Host

七种正式 Agent Type 返回相同结果。本命令没有 Host 渲染、设备登记或本地业务状态写入。
