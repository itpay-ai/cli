# `itpay cart add`

## 范围与意义

把一个已发布 Catalog offer 或一个已准备的 Service Quote 加入 canonical server Cart。Catalog 服务行先进入 `services next`；Quote 行已经锁定输入和价格，可以与其他独立 Execution 的 Quote 一起结算。

**上游：** `catalog list` 返回的 item/variant/offer，或 `services quote` 返回的 Quote ID。
**下游：** `services next <id>`、继续 `cart add --quote`，或 `buy --cart`。

## 语法与参数

```bash
itpay cart add --item <catalog_item_id> --variant <catalog_variant_id> --offer <offer_id>
  [--quantity <n>] [--input <json>] [--host <host>] [--target <target>] [--json] [--local]

itpay cart add --quote <service_quote_lock_id>
  [--host <host>] [--target <target>] [--json]
```

Catalog 模式下 `--item`、`--variant`、`--offer` 必须成组且来自同一记录；`--quantity` 为正整数，`--input` 必须是 JSON object。Quote 模式只接受 `--quote`，不能混用 Catalog 字段、input 或 `--local`。Backend 校验 Quote 有效、未过期、未消费且属于当前设备/账号。

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

Quote 模式返回：

```json
{
  "status": "quote_added",
  "result": { "cart_id": "<cart_id>", "item_count": 3, "total": "<amount> <currency>" },
  "instruction": "付费服务报价已加入同一 Cart；每个项目仍保持独立 Execution 和交付。",
  "next": { "command": "itpay buy --cart <cart_id> --json", "reason": "确认项目齐全后创建一次合并付款" },
  "recovery": [{ "command": "itpay cart show --json", "reason": "检查当前合并 Cart" }]
}
```

## 异常处理

缺少 ID、两种模式混用、非法 quantity、非 object JSON 和缺少 Host target 必须在任何写入/HTTP 前失败。目录不匹配、Quote 过期/跨身份/已消费或 Cart 已锁定由服务端事务拒绝，不得留下半成品 line。错误使用统一 envelope，recovery 指向 `services next`、`catalog list` 或当前 `cart show`。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种类型都写入真实 Agent Type。默认 Host 分别是 `codex`、`terminal`、`claude-code`、`terminal`、`plain-chat`。业务输出合同相同；此命令本身不显示二维码。
