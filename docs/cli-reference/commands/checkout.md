# `itpay checkout`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

读取并恢复一笔已存在 Checkout 的公开展示状态。它不创建新 Checkout，也不把“用户说已付款”当作付款成功。

**上游：** `services purchase`、明确独立Cart的 `buy` 或原 Checkout reader 返回的 `checkout_id` 与 display token。
**下游：** 继续授权/付款、读取关联 Service Execution，或结束等待。

## 语法与参数

```bash
itpay checkout [--id <checkout_id>] [--token <display_token>]
  [--host <host>] [--target <target>] [--locale <zh-CN|en>]
  [--present <auto|browser|image|link|none>] [--no-open] [--viewer <desktop|mobile|unknown>]
  [--relay-option <ref>] [--confirm-relay] [--request-key <key>] [--relay-status <relay_id>]
  [--json]
```

省略 `--id/--token` 时只能使用本机保存的一组完整句柄；不得把其他 Checkout 的 token 拼接使用。

`--host` 默认由 `--agent-type` 决定；`openclaw` 必须显式传当前入口。IM Host 必须提供 `--target`。`--json` 输出机器可读合同，不内嵌二维码字符画或图片二进制。

`--locale` 默认 `zh-CN`，可显式使用 `en`。它只改变重新渲染的 Card 文案，不改变 Checkout、付款、授权或恢复状态。

展示控制（display plane，不创建任何新的付款路径）：

- `--present` 一次只选一种展示方式：`browser` 打开系统浏览器、`image` 展示官方二维码图片、`link` 给出可点击链接、`none` 只说明状态、`auto`（默认）按宿主能力选择一种。`--json` 下默认只返回展示计划而不执行打开；显式 `--present browser` 即是一次打开请求。`ITPAY_NO_BROWSER=1` 与 `--no-open` 都禁止打开浏览器。已付款、已退款或报价失效的 Checkout 不会发起任何展示动作，只读取原状态。
- `--viewer` 告知用户正在看哪类设备：`mobile` 时不会把二维码当作同机可读方式；`desktop` 时才考虑打开浏览器。
- 消息转发（relay）要求服务端已签发的脱敏联系人引用 `--relay-option`、稳定幂等键 `--request-key` 和显式人类同意 `--confirm-relay`，三者缺一不可；CLI 不自行发送短信或邮件。`--relay-status <relay_id>` 只读取一次既有转发结果，绝不重发。`--present` 与 relay 互斥。当前 Backend 未提供 relay 能力时会如实返回不可用。

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
  "instruction": "告诉用户：付款已经确认，订单已经记录，不需要再次付款；结果会在同一订单下继续准备，如果最终无法交付，可以从原订单申请退款，处理方式由内容是否已使用决定。然后只执行 next.command 读取同一笔服务；Agent 不再展示付款入口或创建新订单，也不承诺退款结果。",
  "next": { "command": "itpay services next <service_execution_id> --json", "reason": "读取同一笔已付款 Service Execution" },
  "recovery": []
}
```

已完成状态不得请求 QR PNG、生成二维码、输出附件指令或建议 `pay`。如果 Checkout 包含一个 Service Execution，下一步读取该 execution；通用订单则读取 `order_id`。`refunded`、`failed`、`expired` 同样不生成 handoff，只返回服务端终态和可用恢复方向。

退款说明是用户保障，不是退款承诺。退款资格、自动/人工路径和最终结果仍由原订单的 Refund Owner 根据支付与消费事实决定。

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

## 宿主交付

采用正式 Skill 和当前 handoff 的宿主动作；原生工具不可用或可选图片失败时同轮展示原官方URL，不创建替代付款资源。callback与人的付款陈述都不证明支付；完成、退款或失效状态不再生成付款展示。
