# `itpay feedback submit`

## 范围与意义

把用户明确给出的评分和可选建议记录到一笔已有 Order 的具体服务项目。CLI 读取
同一 Order 选择真实 `order_item_id`，再调用现有 Feedback Owner。用户不需要知道
Order ID、Order Item ID、Device 或 Agent Instance。

## 语法与参数

```bash
itpay feedback submit \
  --order <order_id> \
  --rating <1-5> \
  [--note <text>] \
  [--item-rank <positive_integer>] \
  [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--order <order_id>` | 是 | Agent 从当前订单流程取得，不要求用户提供。 |
| `--rating <1-5>` | 是 | 用户明确给出的 1–5 评分；CLI 归一常见精确写法。 |
| `--note <text>` | 否 | 用户明确表达的建议或卡壳点。 |
| `--item-rank <n>` | 多项目订单条件必填 | 当前 Order items 的 1-based rank。 |
| `--json` | 否 | 输出一个稳定 JSON envelope；Agent 应使用。 |

rating、rank 和 note 长度在任何 Feedback POST 前验证。rating 接受 `5`、`5/5`、
`5分`、`5星`、`5 stars` 和中文 `一` 至 `五` 的精确写法，统一保存为整数；
`2.5`、`6`、`很好` 等含糊或越界值拒绝，不能猜测。完整结构化 note 最长 2000
Unicode code points；超长时不截断用户原话，而是请用户缩短。

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

Backend 继续保存现有 `rating` 和 `note`。CLI 的 note 是可直接在 Admin 阅读的短
Markdown：

```markdown
## Summary
> 支付后等了很久才拿到结果。

## Context
- Source: user-confirmed via agent
- Outcome: delivered
- Service: 企业综合报告
- Client: @itpay/cli <version>
- Agent type: workbuddy
- Environment: development
```

只写用户明确内容和已知安全上下文；禁止 Token、Session、联系方式、内部身份、
Provider 响应、Vault payload、完整命令输出、stack trace 或环境变量。

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
同一 submitter 再次由用户明确提交会更新现有记录并重新进入 `new`，不是创建第二条。

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
  "instruction": "用服务名称和主题让用户选择要评价哪一项；不要展示内部 ID。用户选择后，Agent 使用同一订单、评分和留言并加入所选 item rank 自己执行提交。",
  "next": null,
  "recovery": []
}
```

## 错误合同

| 状态/错误 | 行为 |
| --- | --- |
| `feedback_rating_invalid` | 询问明确的 1–5 评分；没有 HTTP，不猜测。 |
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
