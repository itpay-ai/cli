# `itpay cart remove`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

从未锁定的 canonical cart 删除一个 line。删除不会影响已创建的 Checkout 或订单；如果该 line 是某个未付款 Service Execution 在 Cart 中的最后一个引用，Backend 会在同一事务中取消该 execution。

**上游：** `cart show` 返回的 `cart_item_id`。
**下游：** `cart next`。

## 语法与参数

```bash
itpay cart remove [--line <cart_item_id>] [--json]
itpay cart remove --local --variant <catalog_variant_id> --offer <offer_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--line <cart_item_id>` | 否 | canonical Cart line；省略时使用当前官方 Backend 对应本地状态中最后保存的 line。 |
| `--local` | 否 | 只修改显式本地草稿，不请求 Backend。 |
| `--variant <catalog_variant_id>` | local 时是 | 与 `--offer` 一起标识本地草稿 line。 |
| `--offer <offer_id>` | local 时是 | 与 `--variant` 一起标识本地草稿 line。 |
| `--json` | 否 | 输出标准 JSON envelope。 |

`--line` 不能与 `--local` 混用；`--variant/--offer` 只能与 `--local` 同用。参数在网络请求前完成校验。

## 标准输出

```json
{
  "status": "removed",
  "result": {
    "cart_id": "<cart_id>",
    "cart_item_id": "<line_id>",
    "remaining_item_count": 0
  },
  "instruction": "canonical Cart 已更新；最后一个 service-backed 引用由服务端一致性事务取消。",
  "next": { "command": "itpay cart next --json", "reason": "检查剩余内容" },
  "recovery": []
}
```

显式本地草稿返回 `status: "removed_local"`，下一步固定为 `itpay cart show --local --json`，并明确说明它未验证服务端状态。

## 异常处理

quote/checkout 已锁定时返回 `cart_item_locked`，要求继续已有 Checkout；不得通过清本地状态假装服务端已删除。

成功后 CLI 使用 Backend 返回的剩余 Cart 重新同步本地 line/execution 句柄。删除最后一行后，顶层 `itpay next --json` 必须回到 Cart，而不能路由到已经取消的 Service Execution。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`kimi-code`、`openclaw` 七种 Agent Type 行为相同。
