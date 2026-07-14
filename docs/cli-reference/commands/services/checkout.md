# `itpay services checkout`

## 范围与意义

为单个 Service Execution 快速创建或恢复 Checkout，并按 Host 向人交接付款入口。它是 `services quote -> cart add --quote -> buy --cart` 的单项快捷方式，必须复用相同的 Quote、Cart 和 Checkout Use Case。

**上游：** `services next` 返回的 `prepare_quote` capability 和已验证输入。
**下游：** 人完成 Checkout，随后 `checkout` 或 `services next`。

## 语法与参数

```bash
itpay services checkout <service_execution_id> --capability <capability_id>
  [--input <key=value> ...] [--email <delivery_email>]
  [--host <host>] [--target <target>] [--qr-format <format>] [--qr-file <path>] [--json]

itpay services checkout <service_execution_id> --resume
  [--host <host>] [--target <target>] [--json]
```

创建时 `--capability` 必填。最终 locked input 必须满足 capability schema：显式输入来自 `--input`，服务端也可以按已发布 contract 从当前 Execution 的已批准 action 解析输入。解析后仍缺字段时，必须在创建 Quote、Cart 或 Checkout 前失败。只有 `delivery_email_required=true` 才要求 `--email`，并必须先向用户解释邮箱用于发送可 claim 的交付链接。`--resume` 复用同一个 Checkout 并轮换 handoff token，不再索取输入或邮箱。

## 标准输出

```json
{
  "status": "human_checkout_required",
  "result": {
    "service_execution_id": "<id>",
    "checkout_id": "<checkout_id>",
    "capability_id": "<logical_capability_id>",
    "locked_input": { "<required_key>": "<value>" },
    "amount": "<amount> <currency>"
  },
  "handoff": { "url": "<checkout_url>", "qr_local_path": "<host_optional_path>", "markdown": "<host_optional_markdown>" },
  "instruction": "把付款链接、可用二维码和金额实际发送给用户，然后停止并等待。不要立即执行 next.command，不要创建第二个 Checkout，不要新建 Execution，不要调用 pay。用户表示已经完成付款或要求查询状态后，只执行 next.command；用户的话本身不是付款成功证明。",
  "next": { "command": "itpay checkout --id <checkout_id> --token <display_token> --json", "reason": "仅在用户完成付款操作或要求查询后，读取同一 Checkout 的权威状态" },
  "recovery": []
}
```

`capability_id` 是 service contract 中 Agent 可调用的逻辑 ID，不是 `scc_...` 数据库记录 ID。`locked_input` 是后端按 capability policy 最终解析并校验后的输入，不由 CLI 根据服务名称推断。

普通文本输出保持同一事实顺序。桌面 Host 输出可直接转发的 `handoff.markdown`；终端 Host 额外渲染一个可扫码终端二维码；`--json` 不内嵌终端二维码或图片二进制。

不得返回 quote lock、单独 token、重复 next actions、镜像路径数组或渲染器内部原因。缺输入、缺必填邮箱、phase 不允许时不得创建任何付款资源。恢复时 token 失效应重发同一 Checkout handoff，不创建第二个 Checkout。

## 异常处理

缺少付费 capability 输入：

```json
{
  "status": "error",
  "error": { "code": "capability_input_invalid", "message": "missing required capability input: <field>" },
  "instruction": "补齐付费 capability 的 required_input；本次没有创建 quote、Checkout 或订单。",
  "next": null,
  "recovery": [{ "command": "itpay services checkout <service_execution_id> --capability <capability_id> --input <field>=<value> --json", "reason": "提交完整且会被锁定的服务输入" }]
}
```

缺少交付邮箱：

```json
{
  "status": "error",
  "error": { "code": "delivery_email_required", "message": "delivery email is required before creating this service checkout" },
  "instruction": "该 capability 的交付链接会发送到用户邮箱；先向用户说明用途并询问邮箱，不要代填。",
  "next": null,
  "recovery": [{ "command": "itpay services checkout <service_execution_id> --capability <capability_id> --email <email> --json", "reason": "使用用户提供的邮箱创建 Checkout" }]
}
```

## Agent Type / Host

| Agent Type | Instruction |
|---|---|
| `codex-desktop` | `handoff={url,qr_local_path,markdown}`；把 `handoff.markdown` 原样发送到当前桌面对话。 |
| `codex-cli` | `handoff={url,qr_local_path}`；普通文本模式在用户可见终端渲染二维码。 |
| `claude-code-desktop` | `handoff={url,qr_local_path,markdown}`；把 `handoff.markdown` 原样发送到当前桌面对话。 |
| `claude-code-cli` | `handoff={url,qr_local_path}`；普通文本模式在用户可见终端渲染二维码。 |
| `workbuddy` | `handoff={url,qr_local_path,qr_image_url}`；发送可点击链接，优先把本地路径作为图片附件，不能发送本地附件时使用绝对图片 URL；发送金额后停止等待。 |
