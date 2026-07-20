# `itpay cart show`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

显示 canonical server cart 的紧凑摘要和 line 句柄。默认不展开完整 Service Execution。

**上游：** cart 创建或恢复。
**下游：** `cart next`、`cart remove` 或 `services next`。

## 语法与参数

```bash
itpay cart show [--json] [--local]
```

默认只读取本地保存的 canonical Cart 句柄并调用服务端。`--local` 只查看显式本地兼容草稿，不发 HTTP，也不会把该草稿解释成 canonical Cart。

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

显式 local draft 返回 `shown_local` 或 `local_empty`：

```json
{
  "status": "shown_local",
  "result": {
    "currency": "CNY",
    "items": [
      {
        "catalog_item_id": "<item_id>",
        "catalog_variant_id": "<variant_id>",
        "offer_id": "<offer_id>",
        "quantity": 1
      }
    ]
  },
  "instruction": "这是未验证的本地兼容草稿，只能用于明确的普通商品流程；不要把它当作 canonical Cart。",
  "next": { "command": "itpay buy --json", "reason": "将普通本地草稿提交为 canonical Cart" },
  "recovery": []
}
```

## 异常处理

没有 canonical 句柄时返回 `cart_handle_missing`，next 为 `catalog list --json`，recovery 可显式检查 `cart show --local --json`。服务端句柄过期或无权访问时保持不透明错误，recovery 指向 `services list` 和 Catalog；不得静默回退到 local draft。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 行为相同。
