# `itpay docs search`

## 范围与意义

在内置 topic 的名称、标题、用途和 `search_terms` 中进行不区分大小写的包含搜索。它不搜索完整正文或业务数据。

**上游：** Agent 知道问题关键词，但不知道稳定 topic。

**下游：** 唯一匹配时直接 `docs show`；多匹配时由 Agent 选择一个。

## 语法与参数

```bash
itpay docs search <query> [--json]
```

`query` 必须是非空关键词；`--json` 返回标准命令 envelope。

## 唯一匹配

```json
{
  "status": "matched",
  "result": {
    "query": "render-hosts",
    "topics": [
      {
        "topic": "render-hosts",
        "title": "Host Rendering And Interaction Requests",
        "purpose": "<one-line purpose>"
      }
    ]
  },
  "instruction": "已唯一匹配；读取该 topic。",
  "next": {
    "command": "itpay docs show render-hosts --json",
    "reason": "读取唯一匹配文档"
  },
  "recovery": []
}
```

## 多匹配

返回所有匹配 topic 的同样三字段摘要，`instruction` 要求只选择一个，`next` 为 `null`。CLI 不以文件顺序替 Agent 猜选项。

## 无匹配

```json
{
  "status": "no_match",
  "result": {
    "query": "<query>",
    "topics": []
  },
  "instruction": "没有匹配文档；缩短关键词，或列出全部 topic。",
  "next": {
    "command": "itpay docs list --json",
    "reason": "浏览稳定 topic"
  },
  "recovery": []
}
```

空字符串返回 `docs_query_required`；随包文档损坏返回 `docs_unavailable`。

## Agent Type / Host

五种正式 Agent Type 行为相同。本命令不产生 Host handoff。
