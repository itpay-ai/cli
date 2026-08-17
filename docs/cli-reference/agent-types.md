# Agent Type And Host Contract

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

`--agent-type` 表示哪类运行时在运行 CLI，用于 Agent 实例归属和定制 instruction。`--host` 表示输出展示在哪里；`--target` 只是在某些 Host 中指定 chat/channel/open ID。三者不可混用，窗口、任务和对话也不是身份。

本地只保存一把 Ed25519 私钥。每个规范化 Backend API base URL 独立登记 Device，因此 dev/test/app 分别拥有自己的 device ID、quota lineage、Agent instances 和 sessions。同一 Backend 下每个 `agent_type` 只有一个 Agent Instance；同类型的不同窗口、任务或聊天复用它，不追踪窗口 ID。

## 首批支持类型

| Agent Type | 默认 Host | 初始 instruction 差异 |
|---|---|---|
| `codex-desktop` | `codex` | 返回可在 Codex 桌面对话中展示的本地二维码和官方链接，要求 Agent 将 handoff 实际发到当前对话。 |
| `codex-cli` | `terminal` | 在用户可见终端渲染二维码并输出官方链接；若用户不看该终端，要求使用真实 Host。 |
| `claude-code-desktop` | `claude-code` | 返回桌面对话可展示的 Markdown 图片和官方链接，要求先展示再等待。 |
| `claude-code-cli` | `terminal` | 在用户可见终端输出二维码和官方链接，不声称已在桌面对话展示。 |
| `workbuddy` | `plain-chat` | 返回完整渲染的 HTML Card Link 和可原样执行的 `present_files` action；立即打开 Card Link，不返回或检查本地图片路径。 |
| `zcode` | `plain-chat` | 返回完整渲染的官方 URL；立即用 ZCode 内置浏览器打开，不只粘贴文字链接，也不返回或重建二维码图片。 |
| `kimi-code` | `terminal` | 使用标准 CLI 引导，在用户可见终端渲染二维码和付款链接。 |
| `openclaw` | 无；必须显式传入 | `--host telegram` 使用 OpenClaw 原生 `message` action；其他入口返回标准 HTTPS 二维码和付款链接。 |

## 通用规则

- commerce 命令必须传 `--agent-type` 或设置 `ITPAY_AGENT_TYPE`。
- 兼容入口 `--agent-type codex` / `ITPAY_AGENT_TYPE=codex` 仅在 CLI 参数解析边界规范化为 `codex-desktop`；登记、输出和后续命令始终使用 `codex-desktop`。新文档和 Agent 不得主动生成该别名。`itpay install codex` 仍是无效 target。
- Agent Type 必须真实且稳定；同类型窗口复用同一实例，不得临时换名。
- `next.command` 和 `recovery.command` 必须保留当前显式 Agent Type，不读取或回退到机器上其他类型。
- 显式 `--host` 覆盖默认 Host，但不改变已登记的 Agent Type。
- `--target` 只路由人类展示，不是身份，也不是 capability 业务输入。
- Host 只影响 `instruction` 和 `handoff`，不得改变金额、订单、权限、quota 或交付状态。
- 所有正式 Agent Type 使用同一命令输入和 JSON 外壳；OpenClaw 只在 `handoff` 的既有扩展位置增加平台 action，不改变交易字段。
- 非展示命令在所有正式 Agent Type 下返回相同业务结果，只允许 `instruction` 措辞不同。只有 Host 客观无法展示某种媒介时，`handoff` 才按既有可选字段做最小裁剪。
- `openclaw` 没有默认 Host。展示命令必须显式传 `--host`；缺少时在任何 Checkout 创建或状态迁移前返回 `host_required`。
- OpenClaw 的 IM Host 必须提供 `--target`。缺失时在任何 Checkout 创建前返回 `target_required`。
- `kimi-code` 是 CLI 型 Agent，复用 `terminal` Host 和现有 CLI 展示，不增加 Kimi 专属交易协议。
- `zcode` 使用 `plain-chat` Host 和官方 URL-only handoff。Agent 必须自行在 ZCode 内置浏览器打开 URL；只有内置浏览器确实不可用时才向用户展示同一个可点击链接。
- session 失效时 CLI 只续期并重试原请求一次；再次失败立即返回。revoked v2 Device 不自动换身份。
- 同一 Device 首次登记新的 Agent Type 时，CLI 只使用本地已登记且 Backend 仍接受的既有 Agent Instance 完成签名登记；被撤销的 Instance 会被跳过且不会恢复。若没有任何既有 Instance 可用，CLI 必须停止，不得重新登记 Device、旋转私钥或借用其他 Backend。

## Human Handoff 最小合同

Checkout 与账号读取授权使用相同的 Host 投影规则：`result` 是业务事实，
`handoff` 是必须交给当前用户的操作入口。完整官方 handoff URL 可以展示；
URL 内 credential 不得被提取、单独输出、记录或重建。

### Checkout

```json
{
  "status": "human_checkout_required",
  "result": {
    "checkout_id": "<checkout_id>",
    "amount": "<amount> <currency>"
  },
  "handoff": {
    "url": "<checkout_or_rendered_card_url>",
    "qr_local_path": "<desktop_optional_local_path>",
    "qr_image_url": "<non_workbuddy_optional_absolute_https_png>",
    "markdown": "<desktop_optional_host_ready_markdown>",
    "agent_action": "<host_optional_native_action>"
  },
  "instruction": "<agent-type-specific instruction>",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json"
  },
  "recovery": []
}
```

只返回当前 Host 能使用的 `handoff` 字段，不返回镜像路径列表、渲染器内部状态或重复的 action 描述。

准确字段集合：

| Agent Type / Host | `handoff` keys |
|---|---|
| `codex-desktop / codex` | `url, qr_local_path, markdown` |
| `claude-code-desktop / claude-code` | `url, qr_local_path, markdown` |
| `codex-cli / terminal` | `url`；非 JSON 输出另外渲染终端二维码 |
| `claude-code-cli / terminal` | `url`；非 JSON 输出另外渲染终端二维码 |
| `workbuddy / plain-chat` | `url, agent_action`（`present_files(files=[url])`，打开完整渲染的 HTML Card Link） |
| `zcode / plain-chat` | `url`（立即用 ZCode 内置浏览器打开；不返回图片或平台私有 action） |
| `kimi-code / terminal` | `url`；非 JSON 输出另外渲染终端二维码 |
| `openclaw / telegram` | `url, qr_image_url, agent_action` |
| `openclaw / other` | `url, qr_image_url` |

WorkBuddy instruction 必须要求 Agent 原样执行一次 `handoff.agent_action`，即调用 `present_files(files=[handoff.url])` 在右侧打开 Backend 已渲染的 HTML Card。调用成功后说明金额并停止；调用失败时只发送原始 `handoff.url` 并如实报告未自动打开。禁止把 `present_files` 用于本地文件或二维码 PNG，也不能下载或重建二维码、调用 `pay` 或创建替代付款资源。显式 `--host` 仍覆盖默认展示方式。

ZCode instruction 必须明确要求 Agent 立即用内置浏览器打开 `handoff.url`，确认已发起打开后说明金额并停止。不得只把 URL 当作文字粘贴给用户，也不得下载、解析或重建二维码。只有内置浏览器明确不可用时，才把同一个 `handoff.url` 作为可点击链接展示。CLI 不猜测或输出 ZCode 私有工具调用 JSON。

OpenClaw Telegram 的 `handoff.agent_action` 是可原样执行的原生 `message` tool action。`presentation` 只包含标准 `blocks.buttons`：`📱 手机点这儿支付` 使用扁平 `url`，`📋 已授权给我读` 使用扁平 `value=itp:grant_confirmed:<checkout_id>`；二维码单独使用 action 的 `media`。CLI `instruction` 必须要求 Agent 原样执行该 action，不得改写 Presentation、换用其他消息工具或声称普通文本回复等同于已发送按钮。收到授权 callback 后立即执行 `next.command` 查询同一 Checkout，再只跟随后端返回的同一 Execution grant 流程；callback 只携带 Checkout ID，不携带 display token，也不证明付款或 grant 已生效。OpenClaw `target` 使用原生 chat target（如 `5559456744` 或 `-1001234567890:topic:42`），不添加 `telegram:` 前缀。

### Purchased-content authorization

`vault access` 使用相同字段集合，但不包含金额、Checkout ID、付款状态或付款
查询命令。桌面 handoff 的 Markdown 标题和链接必须明确为“授权查看已购
内容”；Terminal 显示授权二维码；WorkBuddy 用 `present_files` 打开完整
`handoff.url`；ZCode 用内置浏览器打开完整 `handoff.url`；OpenClaw 使用返回的图片/原生 action。

授权 handoff 展示后 `next=null`。用户明确表示已完成时，Agent只重新执行
产生授权要求的原始 `vault list`、`orders` 或 `vault read`，不得再次执行
`vault access` 检查状态。图片展示失败时保留并发送同一个官方 URL，不创建
替代请求。
