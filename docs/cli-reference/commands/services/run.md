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

## 终态和异常

- 成功、付款、交付、授权、退款锁等状态使用既有命令的标准信封，不额外包装 Seller 专用格式。
- `recovery_required` 或 `failed` 返回当前 workflow step，`next: null`，并明确禁止重建 Execution 或重放结果未知的 Provider 请求。
- service 不匹配、输入文件不是 JSON object、timeout 越界或 Backend 错误返回 `workflow_run_failed`。
- `--timeout` 到期不是失败，只返回同一 Execution 当前可恢复状态。

## Agent Type / Host

所有 Local Agent Type 共享同一状态机和 JSON 事实。Host 只改变付款链接、二维码或附件的展示方式，不改变身份、价格、workflow 或交付权限。
