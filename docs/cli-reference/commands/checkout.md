# `itpay checkout`

## 范围与意义

读取并恢复一笔已存在 Checkout 的公开展示状态。它不创建新 Checkout，也不把“用户说已付款”当作付款成功。

**上游：** `buy` 或 `services checkout` 返回的 `checkout_id` 与 display token。
**下游：** 继续授权/付款、读取关联 Service Execution，或结束等待。

## 语法与参数

```bash
itpay checkout [--id <checkout_id>] [--token <display_token>]
  [--host <host>] [--target <target>] [--json]
```

省略 `--id/--token` 时只能使用本机保存的一组完整句柄；不得把其他 Checkout 的 token 拼接使用。

`--host` 默认由 `--agent-type` 决定。`--target` 为现有 IM Host 兼容参数；当前五种 Agent Type 不需要它。`--json` 输出机器可读合同，不内嵌二维码字符画或图片二进制。

## 等待付款输出

```json
{
  "status": "human_checkout_required",
  "result": { "checkout_id": "<checkout_id>", "payment": "pending", "amount": "<amount> <currency>" },
  "handoff": { "url": "<checkout_url>", "qr_local_path": "<host_optional_path>", "markdown": "<desktop_optional_markdown>" },
  "instruction": "把当前 Host 的二维码和付款链接展示给用户，然后等待用户操作；不要创建新 Checkout。",
  "next": { "command": "itpay checkout --id <checkout_id> --token <display_token>", "reason": "稍后查询同一笔 Checkout 状态" },
  "recovery": []
}
```

## 已完成输出

```json
{
  "status": "completed",
  "result": { "checkout_id": "<checkout_id>", "payment": "verified", "order_id": "<optional_order_id>", "service_execution_id": "<optional_id>" },
  "instruction": "付款已确认，不要再次展示付款二维码。",
  "next": { "command": "itpay services next <service_execution_id> --json", "reason": "读取履约状态" },
  "recovery": []
}
```

已完成状态不得请求 QR PNG、生成二维码、输出附件指令或建议 `pay`。如果 Checkout 包含一个 Service Execution，下一步读取该 execution；通用订单则读取 `order_id`。`refunded`、`failed`、`expired` 同样不生成 handoff，只返回服务端终态和可用恢复方向。

## 异常处理

token 缺失或不匹配时使用本机句柄恢复。只有请求的 Checkout 正是本机保存的 Service Checkout 时，才返回对应 `services checkout <service_execution_id> --resume --json`；否则返回 `services list`，不能把另一个 execution 的 token 拼上去，也不能跳到 cart 或新建付款。

```json
{
  "status": "error",
  "error": { "code": "checkout_unavailable", "message": "<missing_or_mismatched_handle>" },
  "instruction": "使用同一笔 Checkout 的完整 checkout_id 与 display token；不要拼接不同 Checkout 的句柄。",
  "next": null,
  "recovery": [{ "command": "itpay services list --json", "reason": "查找当前设备可恢复的 Service Execution" }]
}
```

## Agent Type / Host

等待付款时：

| Agent Type | Handoff |
|---|---|
| `codex-desktop` | `url, qr_local_path, markdown`；原样发送 Markdown。 |
| `codex-cli` | `url, qr_local_path`；普通文本模式渲染终端二维码。 |
| `claude-code-desktop` | `url, qr_local_path, markdown`；原样发送 Markdown。 |
| `claude-code-cli` | `url, qr_local_path`；普通文本模式渲染终端二维码。 |
| `workbuddy` | `url, qr_local_path, qr_image_url`；发送链接和可用附件。 |

完成、退款或失效状态下五种 Agent Type 都只返回同一状态和下一步，不渲染二维码。
