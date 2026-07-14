# Agent Type And Host Contract

`--agent-type` 表示哪类运行时在运行 CLI，用于 Agent 实例归属和定制 instruction。`--host` 表示输出展示在哪里；`--target` 只是在某些 Host 中指定 chat/channel/open ID。三者不可混用，窗口、任务和对话也不是身份。

本地只保存一把 Ed25519 私钥。每个规范化 Backend API base URL 独立登记 Device，因此 dev/test/app 分别拥有自己的 device ID、quota lineage、Agent instances 和 sessions。同一 Backend 下每个 `agent_type` 只有一个 Agent Instance；同类型的不同窗口、任务或聊天复用它，不追踪窗口 ID。

## 首批支持类型

| Agent Type | 默认 Host | 初始 instruction 差异 |
|---|---|---|
| `codex-desktop` | `codex` | 返回可在 Codex 桌面对话中展示的本地二维码图片和付款链接，要求 Agent 将图片实际发到当前对话。 |
| `codex-cli` | `terminal` | 在用户可见终端渲染二维码并输出付款链接；若用户不看该终端，要求改用正确 Host。 |
| `claude-code-desktop` | `claude-code` | 返回桌面对话可展示的 Markdown 图片和付款链接，要求先展示再等待。 |
| `claude-code-cli` | `terminal` | 在用户可见终端输出二维码和链接，不声称已在桌面对话展示。 |
| `workbuddy` | `plain-chat` | 初期返回清晰付款链接和通用图片附件信息；原生卡片细节后续补充。 |

## 通用规则

- commerce 命令必须传 `--agent-type` 或设置 `ITPAY_AGENT_TYPE`。
- Agent Type 必须真实且稳定；同类型窗口复用同一实例，不得临时换名。
- `next.command` 和 `recovery.command` 必须保留当前显式 Agent Type，不读取或回退到机器上其他类型。
- 显式 `--host` 覆盖默认 Host，但不改变已登记的 Agent Type。
- `--target` 只路由人类展示，不是身份，也不是 capability 业务输入。
- Host 只影响 `instruction` 和 `handoff`，不得改变金额、订单、权限、quota 或交付状态。
- 五种 Agent Type 使用同一命令输入和 JSON 外壳；不得为单个 Agent Type 新增、删除或改名协议字段。
- 非展示命令在五种 Agent Type 下返回相同业务结果，只允许 `instruction` 措辞不同。只有 Host 客观无法展示某种媒介时，`handoff` 才按既有可选字段做最小裁剪。
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
    "qr_local_path": "<optional_local_path>",
    "markdown": "<optional_host_ready_markdown>"
  },
  "instruction": "<agent-type-specific instruction>",
  "next": {
    "command": "itpay checkout --id <checkout_id> --token <display_token> --json"
  },
  "recovery": []
}
```

只返回当前 Host 能使用的 `handoff` 字段，不返回镜像路径列表、渲染器内部状态或重复的 action 描述。
