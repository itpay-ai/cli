# `itpay docs show`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取一个指定 Agent 文档 topic。这是 docs 命令族中唯一返回完整文档内容的命令；不会级联读取其他 topic，也不访问 Backend。

**上游：** `docs list` 或唯一匹配的 `docs search`。

**下游：** 结合当前服务端状态，只执行文档中适用的一步。

## 语法与参数

```bash
itpay docs show <topic> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `topic` | 是 | `docs list/search` 返回的稳定、大小写敏感 topic。 |
| `--json` | 否 | 把完整 topic 放进标准 envelope；推荐 Agent 使用。 |

## JSON 输出

```json
{
  "status": "shown",
  "result": {
    "topic": "<topic>",
    "content": {
      "schema_version": "itp.agent_doc.v1",
      "topic": "<topic>",
      "title": "<title>",
      "purpose": "<purpose>"
    }
  },
  "instruction": "只执行文档中与当前服务端状态匹配的步骤；服务端返回的当前 next 优先。",
  "next": null,
  "recovery": []
}
```

`content` 示例仅显示必备头部；实际返回该 topic 的完整结构。非 JSON 模式打印 `shown`、完整 topic JSON 和同一条 instruction，不附加其他 topic。

## 异常处理

topic 不存在返回 `doc_not_found`：

```json
{
  "status": "error",
  "error": {
    "code": "doc_not_found",
    "message": "doc topic not found: <topic>"
  },
  "instruction": "使用稳定 topic 名称；不要根据标题猜 topic。",
  "next": null,
  "recovery": [
    { "command": "itpay docs list --json", "reason": "列出全部 topic" },
    { "command": "itpay docs search <topic> --json", "reason": "按关键词重新搜索" }
  ]
}
```

文档文件损坏使用 `docs_unavailable`，与 `docs list` 相同。

## Agent Type / Host

七种正式 Agent Type 使用同一 topic。topic 若包含多种 Host 指导，Agent 只采用与自身 Agent Type 和当前 Host 匹配的部分。
