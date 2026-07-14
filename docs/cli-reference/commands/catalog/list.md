# `itpay catalog list`

## 范围与意义

列出当前 published Catalog。每个项目先说明用户真正购买的主服务，再说明免费或付费的辅助能力，避免把辅助消歧误称为最终服务。

**上游：** `readyz`。
**下游：** `services start <service_id>`。

## 语法与参数

```bash
itpay catalog list [--json]
```

## 标准输出

```json
{
  "status": "listed",
  "result": {
    "catalog_version": "<version>",
    "services": [
      {
        "service_id": "<service_id>",
        "title": "<product title>",
        "description": "<what the user receives>",
        "discovery": { "title": "<helper title>", "description": "<optional helper>", "free_quota": 3, "paid_price": "<optional price>" },
        "primary_offer": { "title": "<offer title>", "description": "<deliverable>", "price": "<price>" }
      }
    ]
  },
  "instruction": "向用户解释主服务、辅助步骤和价格；得到用户意图后再启动对应 service_id。",
  "next": { "command": "itpay services start <service_id>", "reason": "启动用户选择的服务" },
  "recovery": []
}
```

## 异常处理

输出不得包含 snapshot、manifest 原文、compiled graph 或 Provider secret。服务为空时返回 `catalog_empty`，要求稍后重试，不猜服务 ID。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 使用同一产品内容；只允许排版不同。
