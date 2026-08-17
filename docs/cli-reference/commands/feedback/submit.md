# `itpay feedback submit`

## 范围与意义

在当前 Local Agent 完成一笔已有 Order 后，记录一次最小、安全的服务复盘。用户评分
和原话均为可选；Agent 即使没有收到评分或评论，也要提交已知的服务结果上下文。CLI
通过 Feedback 专用选项接口选择真实项目，再调用现有 Feedback Owner。用户不需要知道
Order ID、Order Item ID、Device 或 Agent Instance。

## 语法与参数

```bash
itpay feedback submit \
  --order <order_id> \
  [--rating <1-5>] \
  [--note <text>] \
  [--item-rank <positive_integer>] \
  [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--order <order_id>` | 是 | Agent 从当前订单流程取得，不要求用户提供。 |
| `--rating <1-5>` | 否 | 用户明确给出的 1–5 评分；缺省表示“未评分”，不能推断。 |
| `--note <text>` | 否 | 用户明确表达的建议或卡壳点。 |
| `--item-rank <n>` | 多项目订单条件必填 | 当前 Order items 的 1-based rank。 |
| `--json` | 否 | 输出一个稳定 JSON envelope；Agent 应使用。 |

`--order` 只能来自当前对话已有的 Order context，或由同一 Local Agent 使用
`services list -> services next` 恢复的原 Service Execution。不得从账号级 `orders`、
Vault、MCP 或另一个 Agent 的历史中取得 Order 并尝试写反馈；这些通道只有读取权，
不证明当前 Agent 是原执行者。

rating、rank 和 note 长度在任何 Feedback POST 前验证。提供 rating 时接受 `5`、`5/5`、
`5分`、`5星`、`5 stars` 和中文 `一` 至 `五` 的精确写法，统一保存为整数；
`2.5`、`6`、`很好` 等含糊或越界值拒绝，不能猜测。完整结构化 note 最长 2000
Unicode code points；超长时不截断用户原话，而是请用户缩短。

同一 Agent 已记录基线复盘时，没有新增用户评分或评论的重复调用返回
`feedback_already_submitted`，且不会覆盖已有反馈；用户以后明确补充评分或评论时仍可更新。

## 项目选择

```text
0 个可反馈 item -> feedback_unavailable，不提交
1 个可反馈 item -> 自动选择
多个 item 且无 rank -> feedback_item_selection_required，不提交
rank 无效 -> feedback_item_invalid，不提交
```

多项目选择只展示 rank、服务标题和安全主题，不展示 `order_item_id`。该状态固定
`next:null`，避免把用户 note 拼进 shell command。用户选定后，Agent 使用同一
订单、评分和留言并加入 `--item-rank` 自己执行。

## 保存格式

Backend 保存可选 `rating` 和 `note`。CLI 的 note 是可直接在 Admin 阅读的短
Markdown：

```markdown
## Summary
> 支付后等了很久才拿到结果。

## Context
- Source: agent-postmortem
- Human input: comment included
- Outcome: delivered
- Service: 企业综合报告
- Client: @itpay/cli <version>
- Agent type: workbuddy
- Environment: development
```

没有用户评论时省略 Summary，但仍保存 Context。只写用户明确内容和已知安全上下文；禁止 Token、Session、联系方式、内部身份、
Provider 响应、Vault payload、完整命令输出、stack trace 或环境变量。
CLI 不读取或上传 Host 对话、WorkBuddy/ZCode sandbox 日志或其他本地 Agent
记录。用户自愿提供本地证据时，Agent 也只能提炼与本单有关的安全摘要，不能把原始
日志作为 Feedback note 上传。

## 成功 JSON

```json
{
  "status": "feedback_submitted",
  "result": {
    "order_code": "IP-…",
    "service_title": "企业综合报告",
    "rating": 5,
    "feedback_status": "new"
  },
  "instruction": "告诉用户反馈已经记录并表示感谢，然后停止。不要承诺回复、处理时间、退款或结果变更。",
  "next": null,
  "recovery": []
}
```

正常结果不返回 `feedback_id`、`order_item_id`、Device、Agent Instance 或 Buyer。
未评分时成功结果省略 `rating`。同一 submitter 在用户后来补充评分或评论时会更新
现有记录并重新进入 `new`，不是创建第二条。

如果用户没有给出评分或评论，Agent 仍提交 Context；成功 instruction 改为“无需打扰
用户”，不得声称用户表达过意见。

## 多项目 JSON

```json
{
  "status": "feedback_item_selection_required",
  "result": {
    "order_code": "IP-…",
    "items": [
      { "rank": 1, "title": "企业名称建议", "subject": "京东" },
      { "rank": 2, "title": "企业综合报告", "subject": "北京京东世纪贸易有限公司" }
    ]
  },
  "instruction": "用服务名称和主题让用户选择要复盘哪一项；不要展示内部 ID。用户选择后，Agent 使用同一订单、已有评分或留言（如有）并加入所选 item rank 自己执行提交。",
  "next": null,
  "recovery": []
}
```

## 错误合同

| 状态/错误 | 行为 |
| --- | --- |
| `order_required` | 使用当前 exact Agent 的 `services list` 恢复原服务；找不到时指向官方订单页或原 Local Agent，不用账号订单/Vault 绕过。 |
| `feedback_rating_invalid` | 用户提供了评分但格式不是 1–5；不提交、不猜测。 |
| `feedback_note_too_long` | 请用户缩短；不截断、不提交。 |
| `feedback_unavailable` | 该 Order 当前没有可反馈项目；不猜 ID。 |
| `feedback_item_invalid` | 重新使用返回的项目 rank；不提交。 |
| `feedback_not_available_for_agent` | 当前 Agent 不能代该订单提交；指向官方订单页或原 Local Agent，不切身份绕过。 |
| `feedback_rejected` | 输入未被记录；只有用户修正明确输入后才重试。 |
| `feedback_submission_unknown` | 无法确认是否记录；停止自动重试，只有用户明确要求后才再次提交。 |

Feedback POST 不做自动 transport retry。虽然 Backend 使用 upsert，重放仍会更新记录
并追加事件，CLI 不能把它当成无副作用查询。

## Agent Type / Host

所有 Local Agent Type 使用相同命令、Device Authority 和 JSON。Host 不改变权限。
Remote MCP 保持只读且没有 Feedback tool。
