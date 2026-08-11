# `itpay vault list`

## 语法

```bash
itpay vault list [--query <text>] [--limit <1..50>] [--cursor <cursor>] [--host <host>] [--target <target>] [--json]
```

在当前 Agent 的有效账号读取授权内，列出以前购买并保存的内容。`--query`
匹配服务名称、内容主体和订单号。CLI 不发送 Buyer ID，也不解密内容 payload。
文本输出的每一项包含服务、内容主体、购买时间、金额、订单号和订单状态，便于
区分同一服务的多次购买；内部 `artifact_ref` 只保留在 JSON 结果中。

## 成功 JSON

```json
{
  "status": "vault_listed",
  "result": {
    "items": [{
      "artifact_ref": "<internal-ref>",
      "service_title": "<title>",
      "subject_label": "<subject>",
      "order_code": "<code>",
      "amount_minor": 200,
      "currency": "CNY",
      "order_status": "delivered",
      "purchased_at": "<RFC3339>",
      "artifact_status": "<status>",
      "access_status": "<status>",
      "created_at": "<RFC3339>",
      "available_sections": ["<section>"]
    }],
    "next_cursor": null
  },
  "instruction": "用编号、服务名称、内容主体、购买时间、金额和订单号说明匹配结果；不要向用户显示内部内容标识。一个精确匹配可按用户原始查看意图继续读取，多个匹配必须让用户选择。",
  "next": null,
  "recovery": []
}
```

空列表使用 `status=no_vault_artifacts`、`items=[]`。它只表示当前账号没有
匹配的已购内容；不得自动启动新查询、购买服务或调用 Provider。

## 授权缺失

```json
{
  "status": "human_authorization_required",
  "result": {
    "intent": "list_purchased_content",
    "query": "<original-query-or-empty>"
  },
  "instruction": "需要用户确认一次身份和只读权限；执行 next.command 生成入口，不要声称链接已经创建。",
  "next": {
    "command": "itpay vault access --json",
    "reason": "创建一次账号读取授权"
  },
  "recovery": []
}
```

授权完成后只重新运行原始 `vault list` 命令，保留 query、limit 和 cursor。
无效 limit/cursor 在 HTTP 前返回稳定错误。授权过期不自动重试、不创建新
Device。OpenClaw 的授权下一步保留原命令的 `--host` 和所需 `--target`；若原
命令没有提供，CLI 使用明确占位符要求 Agent 从当前可信会话补齐。
