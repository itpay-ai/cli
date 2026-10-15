# `itpay vault access`

## 语法

```bash
itpay vault access [--artifact <artifact_ref>] [--host <host>] [--target <target>] [--json]
```

- 无 `--artifact`：请求当前 Local Device + Agent Instance 的账号读取授权。
- 有 `--artifact`：请求首次或敏感内容读取授权；必须已有账号授权。
- `--host` 只选择展示方式，默认由 Agent Type 推导。
- OpenClaw 必须显式提供当前 `--host`；原生消息 Host 需要 `--target`。
- CLI 不接受时长、Buyer ID、回调 URL、MCP Connection ID、浏览器 Session
  或 start token 参数。

## 标准 JSON

```json
{
  "status": "human_authorization_required",
  "result": {
    "request_id": "<id>",
    "purpose": "account_window",
    "artifact_ref": null,
    "request_expires_at": "<RFC3339>"
  },
  "handoff": {
    "url": "https://app.itpay.ai/vault/access/...",
    "qr_local_path": "<desktop-optional-local-path>",
    "markdown": "<desktop-optional-host-ready-markdown>",
    "qr_image_url": "<chat-host-optional-absolute-https-png>"
  },
  "instruction": "说明这是当前智能体的只读授权，实际展示 handoff，然后停止；用户完成后重新运行最初的读取命令。",
  "next": null,
  "recovery": []
}
```

完整 `handoff.url` 是 Backend 批准交给当前用户的短期入口。CLI、Skill 和
Agent不得提取、单独输出、记录或重建其中的 credential；但不得因为 URL
包含 credential 而拒绝展示完整官方 handoff。

同一 pending request 会复用 request ID 并轮换入口 credential，旧链接立即
失效。因此本命令只能按读取命令返回的 `next` 执行一次，不能用重复执行
`vault access` 检查状态。

## 宿主交付

使用当前 handoff 和正式 Skill／render-hosts；原生工具或可选图片不可用时，同轮给出原官方URL，不创建替代授权、不把未展示说成成功。授权交付后停止，人完成后只运行最初的reader。host只改变展示，不扩展权限。
