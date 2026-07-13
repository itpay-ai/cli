# `itpay cart add`

## 范围与意义

把一个已发布 Catalog offer 加入 canonical server cart。服务型 line 可能返回 `service_execution_id`，Agent 应转入 `services next`，而不是直接 `buy`。

**上游：** `catalog list` 返回的 item、variant、offer。
**下游：** `services next <id>` 或 `cart next`。

## 语法与参数

```bash
itpay cart add --item <catalog_item_id> --variant <catalog_variant_id> --offer <offer_id>
  [--quantity <n>] [--input <json>] [--host <host>] [--target <target>] [--json] [--local]
```

`--item`、`--variant`、`--offer` 必填且必须来自同一条 Catalog 记录；`--quantity` 默认 `1`，只接受正整数。`--input` 必须是 JSON object，最终业务字段仍由服务端合同校验。`--local` 不调用服务端。

未显式传 `--host` 时，CLI 根据 `--agent-type` 选择 Host；需要消息目标的 Host 还必须传 `--target`。所有参数在本地草稿写入或 HTTP 请求前完成基础校验。

## 标准输出

```json
{
  "status": "added",
  "result": {
    "cart_id": "<cart_id>",
    "cart_item_id": "<line_id>",
    "service_execution_id": "<optional_id>",
    "title": "<title>",
    "amount": "<amount> <currency>"
  },
  "instruction": "服务型项目已创建 Service Execution；先读取其当前步骤，不要直接进入普通 buy。",
  "next": { "command": "itpay services next <service_execution_id> --json", "reason": "读取服务执行的当前步骤" },
  "recovery": []
}
```

输出只描述本次新增 line，不返回完整 Cart、全部 line、capability 列表、Service read model、client context 或重复 `agent_guidance`。普通项目没有 `service_execution_id`，instruction 要求先检查 canonical Cart，next 为：

```json
{
  "command": "itpay cart next --json",
  "reason": "检查 canonical Cart"
}
```

显式 `--local` 使用独立合同：

```json
{
  "status": "added_local",
  "result": {
    "catalog_item_id": "<item_id>",
    "catalog_variant_id": "<variant_id>",
    "offer_id": "<offer_id>",
    "quantity": 1
  },
  "instruction": "仅写入本地兼容草稿，未验证目录、价格或服务合同；不要把它当作 canonical Cart。",
  "next": { "command": "itpay cart show --local", "reason": "检查本地草稿" },
  "recovery": []
}
```

## 异常处理

缺少 ID、非法 quantity、非 object JSON 和缺少 Host target 必须在任何写入/HTTP 前失败。目录 ID 不匹配、服务合同输入不合法或 cart 已锁定由服务端事务拒绝，不得留下半成品 line。错误使用统一 envelope，recovery 指向 `catalog list` 或当前可执行的 `cart show`。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种类型都写入真实 Agent Type。默认 Host 分别是 `codex`、`terminal`、`claude-code`、`terminal`、`plain-chat`。业务输出合同相同；此命令本身不显示二维码。
