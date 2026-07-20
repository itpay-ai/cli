# `itpay cart next`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取当前 canonical cart 对应的唯一首选动作。它不修改 cart。

**上游：** `cart add` 或中断的 cart 流程。
**下游：** 返回的 `services next`、`buy` 或 `catalog list`。

## 语法与参数

```bash
itpay cart next [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--json` | 否 | 输出单个标准 JSON envelope；默认输出相同事实的简洁文本。 |

命令读取本地保存的 canonical Cart ID，再通过签名 Agent Device session 读取该 Cart。它不接受 Cart ID 参数，也不修改 Cart。

## 标准输出

```json
{
  "status": "action_available",
  "result": {
    "cart_id": "<cart_id>",
    "cart_status": "<status>",
    "service_execution_id": "<service_execution_id>"
  },
  "instruction": "该 Cart 包含 service-backed line；继续 Service Execution，不要从 Cart 猜 capability。",
  "next": {
    "command": "itpay services next <service_execution_id> --json",
    "reason": "读取服务端最新执行状态"
  },
  "recovery": []
}
```

若存在尚未报价的 service-backed line，选择最后一条并返回 `services next`；不跳过 Execution 直接猜 capability。若所有服务行都已绑定 Quote，则返回 Cart 的 item count、总额和 `buy --cart`，允许一次 Checkout 支付多个独立任务。

普通非 service-backed Cart 返回 `item_count`、金额和币种，下一步为：

```text
itpay buy --cart <cart_id> --json
```

空 Cart 返回 `cart_empty`，下一步为 `itpay catalog list --json`。

## 异常处理

本地没有 Cart 句柄时不访问 Backend：

```json
{
  "status": "cart_handle_missing",
  "result": {},
  "instruction": "本地没有 canonical Cart 句柄；先恢复已有资源，不要创建重复 Cart。",
  "next": { "command": "itpay next --json", "reason": "检查其他可恢复句柄" },
  "recovery": [
    { "command": "itpay services list --json", "reason": "从服务端恢复当前设备的执行" }
  ]
}
```

服务端 Cart 不存在、不可访问或 Backend 不可用时返回错误 envelope，不清理本地状态，也不创建替代 Cart。首选 recovery 是 `itpay services list --json`；没有可恢复执行时再运行 `itpay catalog list --json`。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 的业务字段、instruction 和 next 相同。本命令不产生二维码或 Host handoff。
