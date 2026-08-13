# `itpay feedback`

## 命令范围

替用户记录一笔已有订单中某项服务的评分和可选建议。Agent 负责定位订单和项目、
询问缺失的评分并执行命令；用户不运行命令，也不处理内部 ID。

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

- 用户必须明确给出 1–5 分；文字建议可选；
- 先完成交付、故障恢复和退款权利解释，再邀请反馈；
- 用户拒绝、忽略或已经反馈后，同一对话不再询问；
- 成功后只告诉用户反馈已经记录并表示感谢；
- 不自动上传聊天、Prompt、日志、Token、联系方式或已购内容。
