# `itpay services quote`

## 范围与意义

为当前 Service Execution 的一个付费 Capability 准备 Quote Lock。它只锁定可信输入、候选来源、价格、币种和有效期，不创建 Cart、Checkout、订单或 Provider 调用。

本命令是多 Execution 合并付款的高级入口。普通单 Execution 流程应使用 `services checkout`，不要把 `services quote` 当作 Checkout 失败后的替代路径。

**上游：** 用户明确要求合并多个独立 Execution，且每个 Execution 的 Graph 当前都允许 `prepare_quote`。

**下游：** `cart add --quote`。多个独立 Execution 的 Quote 可以加入同一 Cart。

## 语法与参数

```bash
itpay services quote <service_execution_id> --capability <capability_id>
  [--input <key=value> ...] [--email <delivery_email>] [--json]
```

| 参数 | 必填 | 说明 |
|---|---:|---|
| `service_execution_id` | 是 | 候选或输入所属的来源 Execution。 |
| `--capability` | 是 | 当前 `allowed_actions` 明确允许报价的付费 Capability。 |
| `--input` | 条件必填 | 不依赖已批准候选时，提供 schema 要求的输入；可重复。 |
| `--email` | 条件必填 | 仅 `delivery_email_required=true` 时需要，必须来自用户；随 Quote Lock 持久化。 |
| `--json` | 否 | 输出紧凑机器合同。 |

若 Capability 依赖候选，Backend 只从当前 Execution 的 approved Candidate Action 读取 Result Item、Invocation 和 Stable Hash；CLI 不重新提交公司名、候选 ID 或 Hash。

交付联系信息属于 Quote 的锁定事实。多个 Quote 合并付款时，Checkout Owner 汇总它们的联系信息；相同字段值冲突时拒绝创建 Checkout，不由 CLI 选择或覆盖。

## 标准输出

```json
{
  "status": "quote_ready",
  "result": {
    "service_quote_lock_id": "<quote_id>",
    "service_execution_id": "<execution_id>",
    "capability_id": "<capability_id>",
    "price": "<amount> <currency>",
    "expires_at": "<RFC3339>"
  },
  "instruction": "报价已锁定当前 Execution 的可信输入和价格；可单独付款，也可与其他独立 Execution 的报价合并。",
  "next": { "command": "itpay cart add --quote <quote_id> --json", "reason": "加入 canonical Cart" },
  "recovery": [{ "command": "itpay services next <execution_id> --json", "reason": "重新读取当前 Execution 状态" }]
}
```

不得返回 locked input、Candidate Hash、Provider 元数据或完整 Execution DTO。

## 异常处理

- `capability_not_quoteable`：Capability 不存在、免费或当前不可报价；回到同一 Execution 的 `services next`。
- `capability_input_invalid`：缺少 required input；不创建 Quote、Cart 或 Checkout。
- `delivery_email_required`：先说明邮箱用于交付 claim link，再询问用户；禁止代填。
- 候选未确认、来自其他 Execution、Quote 已存在冲突：Backend 拒绝且不改变 Execution。
- `service_quote_not_allowed`：当前 Graph 不允许从当前 Execution 状态购买该 capability；不得换 capability、新建 Execution 或尝试其他购买命令，只回到同一 Execution 的 `services next`。
- Backend 不支持当前交易合同时返回 `backend_contract_incompatible`，必须停止，不能改用 `services checkout`、`cart`、`buy` 或 `pay` 绕过。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 返回相同 Quote 事实、instruction 和 next。本命令不显示二维码；Agent Type 只作为设备与审计上下文，不改变价格或候选规则。
