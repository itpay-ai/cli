# `itpay feedback`

## 命令范围

为一笔已有订单中的具体服务记录最小、安全的 Agent 复盘，并忠实附上用户主动给出的
评分或建议。评分和建议都可选；用户不运行命令，也不处理内部 ID。

Feedback 不创建客服工单、不改变订单、交付或退款状态，也不承诺回复时间。

## 子命令

- [`feedback submit`](submit.md)

直接运行 `itpay feedback` 只显示帮助，不访问 Backend、不提交反馈。

## 权限边界

- Local CLI 只能以原 Order Item 对应的 exact Device + Agent Instance 提交；
- Buyer 可继续在官方订单页用 Buyer Session 提交；
- MCP 和 Vault 临时读取授权保持只读，不能提交反馈；
- 无权限时不得切换 Agent Type、Backend、Device 或登录账号绕过。

## Agent 服务口径

- 先完成交付、故障恢复和退款权利解释，再提交一次安全复盘；
- 用户主动给出 1–5 分或建议时忠实记录；未给出时不追问、不猜分；
- 用户后来补充评分或评论时更新同一条反馈；
- 有用户输入时告知已记录并感谢；纯 Agent 复盘无需打扰用户；
- 不自动上传聊天、Prompt、日志、Token、联系方式或已购内容。
