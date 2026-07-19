# Output And Error Contract

## 目标

CLI 输出是给 Agent 执行的协议，不是后端 DTO 的调试转储。默认输出适合人阅读；`--json` 使用同一语义的稳定机器合同。调试事实只由明确的诊断命令返回。

## 标准 JSON 外壳

```json
{
  "status": "<command_state>",
  "result": {},
  "instruction": "<one concise instruction>",
  "next": {
    "command": "itpay <next-command>",
    "reason": "<why this is next>"
  },
  "recovery": []
}
```

规则：

- `status`：当前命令的业务结果，不是 HTTP 状态。
- `result`：仅包含当前步骤必须使用或向用户说明的事实。
- `instruction`：一条可直接当作 Agent prompt 使用的自然语言指令，不复述 `result`。
- `next`：最多一个首选动作；流程结束时为 `null`。
- `next.command` 是状态机允许的首选延续，不是无条件执行指令；当前结果已满足用户目标时，Agent 应展示结果并停止。
- `recovery`：成功时通常为空；失败或中断时最多两个动作。
- 一旦命令声明 `--agent-type` 或 `ITPAY_AGENT_TYPE`，所有 ItPay `next.command` 和 `recovery.command` 都保留同一类型。
- 相同事实不得同时出现在顶层、`agent_guidance`、`next_actions` 等多个位置。
- 默认隐藏 buyer、device、contract version、compiled graph、quote lock、内部 event ID 等实现细节。
- token、付款 URL 和本地二维码路径只在确实需要交给用户时返回，并不得写入日志型命令。

## 默认文本输出

文本输出与 JSON 字段一一对应，最多四段：

```text
<status summary>
<necessary result lines>
instruction: <what the agent must do>
next: <one command>
```

无下一步时省略 `next`；无异常时省略 `recovery`。

## 标准错误

```json
{
  "status": "error",
  "error": {
    "code": "<stable_error_code>",
    "message": "<human-readable reason>"
  },
  "instruction": "<what not to do and what to correct>",
  "next": null,
  "recovery": [
    { "command": "itpay <recovery-command>", "reason": "<reason>" }
  ]
}
```

错误必须满足：

- 参数和前置条件在产生订单、锁价、扣费、Provider 调用或状态迁移前验证。
- 不得只返回 `invalid_state`；必须说明当前状态和合法恢复入口。
- 重试应复用同一 cart、checkout、execution、order 或 refund ID，不得默认创建新资源。
- 用户口头说“已付款”不是支付事实；仅服务端 `verified` 状态有效。
- `agent_device_session_required` 只触发一次 session 续期和同请求重试；第二次失败必须返回，不得循环或换身份。
- `device_state_unwritable` 表示当前运行环境不能可靠持久化 `~/.itpay-v3`；保持同一 Agent Type 与 CLI/Node launcher，恢复 Host 写权限后重试原命令，不得手工造 lock、删除身份或换运行时碰运气。
- WorkBuddy 在运行会持久化 `~/.itpay-v3` 的 ItPay Bash 命令前，必须把 Shell 工具参数 `dangerouslyDisableSandbox` 设为 `true`。若用户拒绝该权限，命令尚未执行：停止并报告，不得切换 Node、删除 identity、手工处理 lock 或换 Agent Type。
- `provider_input_rejected` 只表示 Provider 明确声明输入无效；`provider_contract_mismatch` 表示响应无法按已发布契约解释，绝不能归咎于用户输入。两者都必须停止且没有自动 recovery。

## Instruction 模板

Instruction 只回答当前最重要的一件事：

```text
说明结果的意义 + 明确 Agent 现在必须做或禁止做的动作。
```

示例：

```text
把付款二维码和链接展示给用户；确认用户可见前不要查询付款状态，也不要创建新 Checkout。
```

不得使用空洞 instruction，例如“继续下一步”“按需处理”“查看详情”。

## 通用性边界

- CLI 不识别企知道、企业查询、某个 capability 名称或某个字段名。
- 必填输入来自 `input_schema.required`。
- 是否收费来自 `requires_payment` 和价格元数据。
- 是否需要邮箱来自 `delivery_email_required`。
- 是否可直接给 Agent 来自 `agent_visible` / `delivery_mode`。
- 下一步来自 Service Execution read model，不由 CLI 猜业务流程。
