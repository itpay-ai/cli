# `itpay cart clear`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

放弃未锁定的 canonical cart。`--local` 只清理本地句柄和草稿，不声称服务端资源已取消。

**上游：** 用户明确放弃购物车。
**下游：** `catalog list`。

## 语法与参数

```bash
itpay cart clear [--local] [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--local` | 否 | 只清除本地草稿与恢复句柄；不请求或修改 Backend。 |
| `--json` | 否 | 输出标准 JSON envelope。 |

不带 `--local` 时只操作 canonical Cart。缺少 Cart 句柄会返回 `cart_handle_missing`，不会静默退化为本地清理。

## 标准输出

```json
{
  "status": "abandoned",
  "result": { "cart_id": "<cart_id>", "server_abandoned": true },
  "instruction": "canonical Cart 已放弃；Backend 已在同一事务中软删除 active lines，并取消其未付款 Service Execution。",
  "next": { "command": "itpay catalog list --json", "reason": "仅在用户提出新需求时重新选择" },
  "recovery": []
}
```

本地清理返回：

```json
{
  "status": "cleared_local",
  "result": { "server_abandoned": false, "local_state_cleared": true },
  "instruction": "仅清除了本地草稿和恢复句柄；Backend Cart、Checkout 和 Service Execution 均未改变。",
  "next": { "command": "itpay catalog list --json", "reason": "仅在用户提出新需求时重新选择" },
  "recovery": []
}
```

## 异常处理

已锁定 Cart 不可放弃时保留本地 Cart、line、execution 和 Checkout 句柄，返回 Backend 的错误 code（通常为 `cart_item_locked`）并引导 `itpay cart next --json`。不得通过清理本地状态伪装 Backend 已放弃。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 行为相同。
