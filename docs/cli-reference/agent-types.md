# Agent Type And Host Contract

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

`--agent-type` 表示哪类运行时在运行 CLI，用于 Agent 实例归属和定制 instruction。`--host` 表示输出展示在哪里；`--target` 只是在某些 Host 中指定 chat/channel/open ID。三者不可混用，窗口、任务和对话也不是身份。

本地只保存一把 Ed25519 私钥。每个规范化 Backend API base URL 独立登记 Device，因此 dev/test/app 分别拥有自己的 device ID、quota lineage、Agent instances 和 sessions。同一 Backend 下每个 `agent_type` 只有一个 Agent Instance；同类型的不同窗口、任务或聊天复用它，不追踪窗口 ID。

## 首批支持类型

| Agent Type | 默认 Host | 初始 instruction 差异 |
|---|---|---|
| `codex-desktop` | `codex` | 返回可在 Codex 桌面对话中展示的本地二维码图片和付款链接，要求 Agent 将图片实际发到当前对话。 |
| `codex-cli` | `terminal` | 在用户可见终端渲染二维码并输出付款链接；若用户不看该终端，要求改用正确 Host。 |
| `claude-code-desktop` | `claude-code` | 返回桌面对话可展示的 Markdown 图片和付款链接，要求先展示再等待。 |
| `claude-code-cli` | `terminal` | 在用户可见终端输出二维码和链接，不声称已在桌面对话展示。 |
| `workbuddy` | `plain-chat` | 只返回 HTTPS 二维码和付款链接；要求 Agent 用 `present_files` 在右侧预览打开二维码，不返回或检查本地图片路径。 |
| `kimi-code` | `terminal` | 使用标准 CLI 引导，在用户可见终端渲染二维码和付款链接。 |
| `openclaw` | 无；必须显式传入 | `--host telegram` 使用 OpenClaw 原生 `message` action；其他入口返回标准 HTTPS 二维码和付款链接。 |

## 通用规则

- commerce 命令必须传 `--agent-type` 或设置 `ITPAY_AGENT_TYPE`。
- Agent Type 必须真实且稳定；同类型窗口复用同一实例，不得临时换名。
- `next.command` 和 `recovery.command` 必须保留当前显式 Agent Type，不读取或回退到机器上其他类型。
- 显式 `--host` 覆盖默认 Host，但不改变已登记的 Agent Type。
- `--target` 只路由人类展示，不是身份，也不是 capability 业务输入。
- Host 只影响 `instruction` 和 `handoff`，不得改变金额、订单、权限、quota 或交付状态。
- 七种 Agent Type 使用同一命令输入和 JSON 外壳；OpenClaw 只在 `handoff` 的既有扩展位置增加平台 action，不改变交易字段。
- 非展示命令在七种 Agent Type 下返回相同业务结果，只允许 `instruction` 措辞不同。只有 Host 客观无法展示某种媒介时，`handoff` 才按既有可选字段做最小裁剪。
- `openclaw` 没有默认 Host。展示命令必须显式传 `--host`；缺少时在任何 Checkout 创建或状态迁移前返回 `host_required`。
- OpenClaw 的 IM Host 必须提供 `--target`。缺失时在任何 Checkout 创建前返回 `target_required`。
- `kimi-code` 是 CLI 型 Agent，复用 `terminal` Host 和现有 CLI 展示，不增加 Kimi 专属交易协议。
- session 失效时 CLI 只续期并重试原请求一次；再次失败立即返回。revoked v2 Device 不自动换身份。

## Checkout Handoff 最小合同

```json
{
  "status": "human_checkout_required",
  "result": {
    "checkout_id": "<checkout_id>",
    "amount": "<amount> <currency>"
  },
  "handoff": {
    "url": "<checkout_url>",
    "qr_local_path": "<desktop_optional_local_path>",
    "qr_image_url": "<workbuddy_optional_absolute_https_png>",
    "markdown": "<desktop_optional_host_ready_markdown>"
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
| `workbuddy / plain-chat` | `url, qr_image_url` |
| `kimi-code / terminal` | `url`；非 JSON 输出另外渲染终端二维码 |
| `openclaw / telegram` | `url, qr_image_url, agent_action` |
| `openclaw / other` | `url, qr_image_url` |

WorkBuddy instruction 只在 `handoff.qr_image_url` 存在时要求读取其完整字符串并作为 `files` 数组唯一元素调用 `present_files`。如果该可选字段不存在，必须直接发送 `handoff.url`，明确不要调用 `present_files`。两种情况都要停止等待；不能检查本地文件、下载或重建二维码、调用 `pay` 或创建替代付款资源。显式 `--host` 仍覆盖默认展示方式，因此只有 `workbuddy + plain-chat` 使用该规则。

OpenClaw Telegram 的 `handoff.agent_action` 是可原样执行的原生 `message` tool action。`presentation` 只包含标准 `blocks.buttons`：`📱 手机点这儿支付` 使用扁平 `url`，`📋 已授权给我读` 使用扁平 `value=itp:grant_confirmed:<checkout_id>`；二维码单独使用 action 的 `media`。CLI `instruction` 必须要求 Agent 原样执行该 action，不得改写 Presentation、换用其他消息工具或声称普通文本回复等同于已发送按钮。收到授权 callback 后立即执行 `next.command` 查询同一 Checkout，再只跟随后端返回的同一 Execution grant 流程；callback 只携带 Checkout ID，不携带 display token，也不证明付款或 grant 已生效。OpenClaw `target` 使用原生 chat target（如 `5559456744` 或 `-1001234567890:topic:42`），不添加 `telegram:` 前缀。
