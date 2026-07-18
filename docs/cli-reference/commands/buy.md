# `itpay buy`

## 范围与意义

为普通 Catalog 项目或已绑定 Service Quote 的 canonical Cart 创建一个 ItPay Checkout，并按当前 Agent Type 把付款入口交给用户。命令只创建或恢复 ItPay Checkout，不把“用户说已付款”当作付款成功。

未报价的 service-backed line 不可购买；命令停止并转向 `services next`。已通过 `cart add --quote` 锁定输入和价格的服务行可以合并结算，每个 Order Item 仍映射回独立 Execution、Capability 和交付路径。

**直接上游：**

- `cart add` 创建的 canonical Cart；
- `cart add --local` 创建的本地兼容草稿；
- Catalog 返回的一组完整 `item / variant / offer`；
- 已知的普通 canonical `cart_id`。

**直接下游：** `checkout` 查询同一 Checkout 的权威状态。付款确认后，再按其返回的 `next` 进入订单或服务履约。

## 语法

```bash
itpay buy [--json]

itpay buy --cart <cart_id> [--json]

itpay buy \
  --item <catalog_item_id> \
  --variant <catalog_variant_id> \
  --offer <offer_id> \
  [--quantity <positive_integer>] [--json]
```

通用选项：

```text
--ref <client_reference_id>
--contact-email <email>
--contact-phone <phone>
--require-contact <email,phone>
--host <host>
--target <target>
--qr-format <unicode|utf8|ansi|terminal>
--qr-file <path>
--pay
--method <alipay|wechatpay>
--no-wait
--timeout <positive_seconds>
--json
```

## 参数合同

| 参数 | 必填 | 规则 |
|---|---:|---|
| `--cart` | 条件必填 | 使用一个已存在的普通或全量已报价 canonical Cart。不能和 inline 三元组同时使用。 |
| `--item` | 条件必填 | Inline 购买时必须与 `--variant`、`--offer` 一起提供。只能使用 Catalog 返回值。 |
| `--variant` | 条件必填 | 同上。 |
| `--offer` | 条件必填 | 同上。 |
| `--quantity` | 否 | 正整数，默认 `1`；只用于 inline 项目。 |
| `--ref` | 否 | 调用方自己的业务引用；不承担幂等职责。 |
| `--contact-email` | 条件必填 | 普通 Cart 或兼容旧 Quote 缺少所需邮箱时使用，值必须来自用户；新版 Service Quote 会自动携带已确认邮箱。 |
| `--contact-phone` | 条件必填 | `--require-contact` 包含 `phone` 时必填，值必须来自用户。 |
| `--require-contact` | 否 | 只接受 `email`、`phone`；缺失时先询问用户，禁止 Agent 编造。 |
| `--host` | 否 | 默认由 `--agent-type` 推导；只改变 handoff 展示，不改变交易事实。 |
| `--target` | 条件必填 | 只有要求目标会话的 IM Host 才需要；当前首批五种 Agent Type 无需提供。 |
| `--qr-format` | 否 | 非 JSON 的终端渲染选项。 |
| `--qr-file` | 否 | 非 JSON handoff 的明确二维码文件路径。 |
| `--pay` | 否 | 创建 Payment Intent 的集成/运维入口；普通 Agent 流程只展示 Checkout。 |
| `--method` | 否 | 只接受 `alipay` 或 `wechatpay`，默认 `alipay`；仅随 `--pay` 生效。 |
| `--no-wait` | 否 | 只能与 `--pay` 一起使用。 |
| `--timeout` | 否 | 等待付款事件的正整数秒数，默认 `120`。 |
| `--json` | 否 | 输出本文定义的紧凑机器合同，不输出字符二维码或图片二进制。 |

不传 `--cart` 或 inline 三元组时，命令使用本机保存的 active canonical Cart；若没有，则使用本地普通草稿创建 canonical Cart。两者都没有时返回 `cart_empty`。

## 标准 JSON 输出

### 等待用户付款

```json
{
  "status": "human_checkout_required",
  "result": {
    "checkout_id": "<checkout_id>",
    "payment": "pending",
    "amount": "<amount> <currency>",
    "item_count": 1
  },
  "handoff": {
    "url": "<tokenized_checkout_url>",
    "qr_local_path": "<desktop_optional_host_ready_file>",
    "markdown": "<desktop_only_optional_markdown>",
    "qr_image_url": "<workbuddy_only_absolute_https_png>"
  },
  "instruction": "<current_host_instruction>",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json",
    "reason": "稍后查询同一笔 Checkout 状态"
  },
  "recovery": []
}
```

`handoff` 只保留当前 Host 可以使用的字段。不得返回二维码 base64、镜像路径数组、renderer 状态、原始后端 DTO 或重复的 `agent_action`。

**Instruction：** 必须使用下方 Agent Type 表定义的展示动作；展示完成或失败后停止。只有用户明确表示已付款或要求查询时才执行 `next.command`，并以后端状态为准。

### `--pay` 已观察到付款事件

```json
{
  "status": "payment_event_observed",
  "result": {
    "checkout_id": "<checkout_id>",
    "payment": "verified",
    "amount": "<amount> <currency>",
    "item_count": 1,
    "payment_intent_id": "<payment_intent_id>",
    "payment_intent_status": "<provider_status>"
  },
  "instruction": "已观察到付款确认事件；读取同一 Checkout 的权威完成状态，不要再次付款。",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json",
    "reason": "读取订单和履约句柄"
  },
  "recovery": []
}
```

事件观察不是订单 DTO。Agent 必须执行 `next.command`，不能自行宣称履约完成。

## 幂等与中断恢复

- CLI 在本机 operation journal 中为 `checkout.create:<cart_id>` 保存稳定幂等键。
- HTTP 请求通过 `Idempotency-Key` 提交该键。
- Checkout 响应丢失时，重跑同一命令会复用已保存的 canonical Cart 和同一幂等键。
- 后端返回同一个待处理 Checkout，并轮换新的交接 token；不会创建第二笔订单。
- Service Quote Cart 的联系信息由 Quote Lock 汇总；正常流程无需在 `buy` 重复传邮箱，旧 Quote 可显式补充。
- Checkout 成功保存后，active Cart 句柄被清除，只保留 Checkout（以及可选 Service Execution）恢复句柄。
- 不确定命令执行到哪一步时，先运行 `itpay next --json`，不得重新拼一笔购买。

## 异常处理

| 错误码 | 含义 | Agent 处理 |
|---|---|---|
| `buy_source_invalid` | Inline 三元组不完整，或与 `--cart` 混用。 | 从 Catalog 重新读取完整 ID，或只保留 `--cart`。 |
| `cart_empty` | 没有本地草稿或 active canonical Cart。 | 执行 `catalog list`，不要猜 ID。 |
| `missing_contact` | 缺少调用方声明的 required contact。 | 向用户询问后重跑同一命令；禁止编造。 |
| `contact_field_invalid` | `--require-contact` 包含不支持字段。 | 只使用 `email`、`phone`。 |
| `payment_method_invalid` | 付款方式不是允许值。 | 使用 `alipay` 或 `wechatpay`。 |
| `buy_parameter_invalid` | quantity/timeout 非正整数，或 `--no-wait` 未配 `--pay`。 | 修正参数；本次不创建资源。 |
| `service_quote_required` | Cart 含尚未绑定 Quote 的 Service Execution。 | 原样执行返回的 `services next <id> --json`；不要绕过 Quote 输入校验。 |
| `idempotency_conflict` | 同一幂等操作被用于不同请求。 | 保留句柄并执行 `itpay next --json`，不要换键重建。 |
| `buy_failed` | 网络或未知后端错误。 | 先执行 `itpay next --json` 或 `cart next --json` 恢复现有资源。 |

所有参数错误都必须在 HTTP 和本地 Cart 变更前被拒绝。服务 Cart 只有每条 service-backed line 都绑定有效 Quote 时才能创建 Checkout；付款后 Backend 按 Order Item 分别推进 Execution。

## Agent Type / Host

| Agent Type | 默认 Host | JSON handoff | Instruction |
|---|---|---|---|
| `codex-desktop` | `codex` | `url`、可用时 `qr_local_path` 和 `markdown` | 把 `handoff.markdown` 原样发到当前 Codex 对话，确认二维码和链接可见后等待。 |
| `codex-cli` | `terminal` | `url` | 非 JSON 模式在用户可见终端渲染二维码；始终保留付款链接。 |
| `claude-code-desktop` | `claude-code` | `url`、可用时 `qr_local_path` 和 `markdown` | 把 Markdown handoff 发到当前桌面对话，不能只输出本地路径。 |
| `claude-code-cli` | `terminal` | `url` | 在用户可见终端展示；不能声称桌面对话已收到图片。 |
| `workbuddy` | `plain-chat` | `url, qr_image_url` | 读取完整 `qr_image_url` 并作为 `files` 数组唯一元素调用 `present_files`；右侧打开后发送金额和链接并停止，不读取本地文件。 |

显式 `--host` 可以覆盖展示方式，但不会改变 Agent Type、设备身份、金额、权限或交易状态。
