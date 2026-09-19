# `itpay services run`

## 范围与意义

运行 Catalog 中已发布的通用 Buyer workflow。CLI 只提交服务声明要求的输入，并复用现有 Service Execution、Checkout、交付和退款命令；它不解释或执行 Seller 提供的任意命令文本。

没有提供输入时，本命令创建一次 Execution，返回已发布的 JSON input schema，并要求 Agent 继续同一 Execution。已有 Execution 必须通过 `--execution` 恢复，不能创建替代 Execution。

## 语法与参数

```bash
itpay services run <service_id>
  [--input-json <file>]
  [--execution <service_execution_id>]
  [--timeout <seconds>]
  [--host <host>]
  [--target <target>]
  [--json]
```

| 参数 | 说明 |
| --- | --- |
| `service_id` | Catalog 返回的服务 ID。恢复时必须与 Execution 所属服务一致。 |
| `--input-json` | UTF-8 JSON 文件；顶层必须是 object，并符合服务发布的 input schema。 |
| `--execution` | 恢复同一 Execution。不得用它切换服务或绕过原状态。 |
| `--timeout` | 本次等待 workflow 状态变化的秒数，默认 120，范围 0–600；超时只返回当前状态。 |
| `--host` / `--target` | Host 展示上下文，不是业务输入或 Buyer 身份。 |
| `--json` | 输出稳定 JSON 信封。 |

## 缺少输入

```json
{
  "status": "input_required",
  "result": {
    "service_execution_id": "<execution_id>",
    "service_id": "<service_id>",
    "input_schema": { "type": "object", "required": ["<field>"] }
  },
  "instruction": "根据服务声明填写输入，然后继续同一服务执行。",
  "next": {
    "command": "itpay services run <service_id> --execution <execution_id> --input-json <file> --json",
    "reason": "提交买家输入"
  },
  "recovery": []
}
```

Agent 必须展示 schema 所需信息并等待用户提供真实输入；不得猜值，也不得为补输入创建新 Execution。

## 执行与付款

提供输入后，CLI 使用稳定 idempotency key 向同一 Execution 提交一次。`queued` 或 `running` 只轮询该 Execution。进入付款步骤时，CLI 调用现有 `services checkout`，返回其标准 `human_checkout_required` 输出和 Host handoff；不会实现第二套付款逻辑。

付款完成后即使 CLI 已退出，Backend 仍继续该 workflow。再次运行：

```bash
itpay services run <service_id> --execution <execution_id> --json
```

只恢复当前状态。交付、Vault 授权和退款继续使用 `services next`、`services read-result`、`vault` 与 `refund` 的既有合同。

## 免费试用额度与 `login_required`

铁路查询类服务对未登录设备提供按服务独立计数的免费试用（`itpay-rail-exact` 与 `itpay-rail-smart` 各 2 次，互不共享）。额度在查询产生供应商副作用前由服务端原子记账：地点确认、内部多阶段、轮询和已保存结果分页不重复扣次；参数校验失败且未执行查询时不扣次。

试用耗尽时，查询在供应商调用**之前**被暂停，Execution 不失败，已提交的输入服务端保留：

```json
{
  "status": "login_required",
  "result": {
    "service_execution_id": "<execution_id>",
    "service_id": "itpay-rail-exact",
    "admission": "login_required",
    "query_quota": [
      { "service_id": "itpay-rail-exact", "used": 2, "limit": 2, "remaining": 0 },
      { "service_id": "itpay-rail-smart", "used": 0, "limit": 2, "remaining": 2 }
    ]
  },
  "instruction": "该服务的免费查询次数已用完（exact 2/2，smart 仍剩 2/2）。请用户在官方页面完成登录后继续免费查询；本次查询输入已保留，登录后恢复同一执行即可，不要新建执行或让用户重述行程。smart 额度属于另一类服务，不能拿它顶替 exact 查询。",
  "next": {
    "command": "itpay auth login --json",
    "reason": "完成官方登录绑定后继续免费查询"
  },
  "recovery": [
    {
      "command": "itpay services run itpay-rail-exact --execution <execution_id> --json",
      "when": "auth_bound",
      "reason": "登录绑定完成后恢复同一查询执行"
    }
  ]
}
```

`query_quota` 如实报告两类额度各自用量，一类为零不得宣称"四次全部用完"。第四次查询的结果先正常交付，下一次新查询才需要授权。

登录绑定完成后，再次运行同一条 `services run <service> --execution <id> --json`（不带输入文件）：服务端重新读取当前设备绑定身份，被暂停的 Execution 从额度节点继续，不重放已成功的供应商调用，不要求重新输入。`failed`、`recovery_required` 或已完成付款的 Execution 不能以这种方式恢复。

## `rate_limited`

已注册账号查询不设累计次数上限，但受正常每分钟限流：

```json
{
  "status": "rate_limited",
  "result": {
    "service_execution_id": "<execution_id>",
    "service_id": "<service_id>",
    "admission": "rate_limited",
    "retry_after_ms": 42000
  },
  "instruction": "触发正常限流；等待后恢复同一执行，不要新建查询。",
  "next": {
    "command": "itpay services run <service_id> --execution <execution_id> --json",
    "after_ms": 42000,
    "reason": "限流窗口过后继续同一查询"
  },
  "recovery": []
}
```

限流不是收费、不是试用耗尽、不需要重新登录。等待中不得重复扣试用或发起新的供应商请求。

## 已选车次的购票输入（selection）

对 `itpay-rail-booking`，输入支持两种等价方式。优先使用查询结果里服务端签发的购买承接：

```json
{
  "passengers": 1,
  "selection": {
    "token": "<查询结果项中的 booking_offer.selection_token>",
    "seat_type": "O"
  }
}
```

`selection.token` 绑定一次具体查询结果快照与其中的班次/方案；服务端校验归属、快照版本、时效后推导权威 `legs` 并实时核价。Agent 只提交用户选定的承接、`seat_type`（必要时）与乘客人数，**绝不手工拼装 `legs`、站码、时刻或供应商形状**。显式 `legs` 输入仍然有效，字段即购票服务发布的 `input_schema`（`passengers` 为 1–5 整数人数，不是乘客身份数组）。

相同 selection 重复提交恢复同一购票执行，不会重复核价或建单。

## 终态和异常

- 成功、付款、交付、授权、退款锁等状态使用既有命令的标准信封，不额外包装 Seller 专用格式。
- 既有 Checkout、身份、兼容性和网络错误保持原错误码、instruction 与 recovery；`services run` 不得覆盖可执行的邮箱、登录、升级或状态恢复指令。
- 如果创建 Execution 后未收到完整响应，返回 `workflow_start_outcome_unknown`，只允许先执行 `itpay services list --json` 查找刚创建的 Execution；不得直接重跑 `services run` 创建替代 Execution。
- `recovery_required` 或 `failed` 返回当前 workflow step，`next: null`，并明确禁止重建 Execution 或重放结果未知的 Provider 请求。
- service 不匹配、输入文件不是 JSON object、timeout 越界或 Backend 错误返回 `workflow_run_failed`。
- `--timeout` 到期不是失败，只返回同一 Execution 当前可恢复状态。

## Agent Type / Host

所有 Local Agent Type 共享同一状态机和 JSON 事实。Host 只改变付款链接、二维码或附件的展示方式，不改变身份、价格、workflow 或交付权限。
