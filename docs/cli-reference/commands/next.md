# `itpay next`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

从本机保存的 canonical Cart、Checkout 或 Service Execution 句柄恢复一个首选动作。它是中断后的总入口，不替代具体资源的 `next/get`，也不读取或复制 Backend DTO。

**上游：** 任意创建过 cart、checkout 或 execution 的 CLI 流程。
**下游：** 返回的单一恢复命令。

句柄优先级固定为：

```text
Service Execution -> Checkout -> Cart -> Catalog
```

一条 Service Execution 流程通常同时留下 Cart 和 Checkout 句柄；优先恢复最具体的 execution 可避免从旧 Cart 重建资源。

## 语法与参数

```bash
itpay next [--json]
```

| 参数 | 必填 | 说明 |
|---|---:|---|
| `--json` | 否 | 返回标准 JSON。 |

该命令只读本地 `0600` handle cache，不访问 Backend、不创建资源，也不要求 Buyer session。返回的下一条资源命令负责读取服务端权威状态。

## 标准输出

```json
{
  "status": "resume_available",
  "result": { "resource_type": "service_execution", "resource_id": "<service_execution_id>" },
  "instruction": "继续已有资源，不要创建重复订单或 Checkout。",
  "next": { "command": "itpay services next <service_execution_id> --json", "reason": "读取服务端最新状态" },
  "recovery": []
}
```

Checkout 句柄返回：

```json
{
  "status": "resume_available",
  "result": { "resource_type": "checkout", "resource_id": "<checkout_id>" },
  "instruction": "继续已有资源，不要创建重复订单或 Checkout。",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json",
    "reason": "恢复同一 Checkout"
  },
  "recovery": []
}
```

只存在 Cart 句柄时，`resource_type` 为 `cart`，下一步是 `itpay cart next --json`。

没有本地句柄时：

```json
{
  "status": "nothing_to_resume",
  "result": {},
  "instruction": "本地没有可恢复句柄；先读取已发布目录，不要猜测 service_id。",
  "next": { "command": "itpay catalog list --json", "reason": "选择已发布服务" },
  "recovery": []
}
```

本地状态文件损坏或不可读时不静默猜测资源：

```json
{
  "status": "local_state_invalid",
  "result": {},
  "instruction": "本地恢复句柄无法读取；不要猜测资源 ID，改从当前设备可见的服务执行恢复。",
  "next": { "command": "itpay services list --json", "reason": "从服务端恢复当前设备可见的执行" },
  "recovery": []
}
```

若下一条资源命令发现服务端句柄已经失效，遵循该命令的结构化 recovery；不要修改本地文件或猜 ID。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy`、`kimi-code`、`openclaw` 七种 Agent Type 的状态、instruction 和下一步完全相同。本命令不产生二维码或 Host handoff。
