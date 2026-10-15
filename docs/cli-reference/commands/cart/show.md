# `itpay cart show`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

显示 canonical server cart 的紧凑摘要和 line 句柄。默认不展开完整 Service Execution。

**上游：** cart 创建或恢复。
**下游：** `cart next`、`cart remove` 或 `services next`。

## 语法与参数

```bash
itpay cart show [--json] [--local]
```

默认只读取本地保存的 canonical Cart 句柄并调用服务端。`--local` 只查看显式本地未验证草稿，不发 HTTP，也不会把该草稿解释成 canonical Cart。

## 标准输出

```json
{
  "status": "shown",
  "result": {
    "cart_id": "<cart_id>",
    "status": "<status>",
    "amount": "<amount> <currency>",
    "items": [{ "cart_item_id": "<id>", "title": "<title>", "quantity": 1, "service_execution_id": "<optional_id>" }]
  },
  "instruction": "使用 line 或 execution 句柄继续，不要使用内部 quote lock ID。",
  "next": { "command": "itpay cart next --json", "reason": "取得当前首选动作" },
  "recovery": []
}
```

canonical 输出不得包含 Catalog variant/offer、line input、Service quote lock、完整 Service Execution 或重复 guidance。空 Cart 的 next 改为 `catalog list --json`。

显式 local draft 只展示未验证草稿（shown_local/local_empty）；不验证目录或价格，不能作为原购买恢复或授权替代。要继续独立Cart时只按当前返回的完整动作，不由示例生成新的购买命令。

## 异常处理

没有 canonical 句柄时返回 `cart_handle_missing`，next 为 `catalog list --json`，recovery 可显式检查 `cart show --local --json`。服务端句柄过期或无权访问时保持不透明错误，recovery 指向 `services list` 和 Catalog；不得静默回退到 local draft。

## Agent Type / Host

所有正式支持的 Local Agent Type 行为相同。
