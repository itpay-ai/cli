# `itpay checkout`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

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

`--host` 默认由 `--agent-type` 决定；`openclaw` 必须显式传当前入口。IM Host 必须提供 `--target`。`--json` 输出机器可读合同，不内嵌二维码字符画或图片二进制。

## 等待付款输出

```json
{
  "status": "human_checkout_required",
  "result": { "checkout_id": "<checkout_id>", "payment": "pending", "amount": "<amount> <currency>" },
  "handoff": { "url": "<checkout_url>", "qr_local_path": "<desktop_optional_path>", "qr_image_url": "<chat_optional_absolute_https_png>", "markdown": "<desktop_optional_markdown>", "agent_action": "<openclaw_telegram_optional_native_message_action>" },
  "instruction": "<exact_agent_type_instruction>",
  "next": { "command": "itpay checkout --id <checkout_id> --token <display_token> --json", "reason": "稍后只查询同一 Checkout" },
  "recovery": []
}
```

## 已完成输出

```json
{
  "status": "completed",
  "result": { "checkout_id": "<checkout_id>", "payment": "verified", "order_id": "<optional_order_id>", "service_execution_id": "<optional_id>" },
  "instruction": "Backend 已确认这笔付款。不要再次展示付款入口，不要调用 pay，不要创建新 Checkout 或 Execution。现在只执行 next.command，读取同一 Execution 的履约结果。",
  "next": { "command": "itpay services next <service_execution_id> --json", "reason": "读取同一笔已付款 Service Execution" },
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
| `codex-cli` | `url`；普通文本模式渲染终端二维码。 |
| `claude-code-desktop` | `url, qr_local_path, markdown`；原样发送 Markdown。 |
| `claude-code-cli` | `url`；普通文本模式渲染终端二维码。 |
| `workbuddy` | `url, qr_image_url?`；有二维码 URL 时按 `services checkout` 相同规则调用 `present_files`，没有时只发送 Checkout URL，不生成本地文件。 |
| `kimi-code` | `url`；普通文本模式渲染标准终端二维码。 |
| `openclaw` | Telegram 为 `url,qr_image_url,agent_action`；instruction 强制原样执行 action。`📋 已授权给我读` callback 触发同一 Checkout 查询，再由 Backend 决定是否进入 grant 读取；其他显式 Host 为 `url,qr_image_url`。 |

完成、退款或失效状态下所有 Agent Type 都只返回同一状态和下一步，不渲染二维码。OpenClaw 的 `--target` 必须使用原生 chat target 并传入展示层，不能添加 `telegram:` 前缀或被 CLI 参数解析后丢弃。
