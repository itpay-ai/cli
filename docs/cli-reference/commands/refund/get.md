# `itpay refund get`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. Under that one product entry point, the two top-level commerce actions are `buy` and `sell`: Buyer workflows are available now; Seller workflows will use the same entry point and are not implemented yet.

## 范围与意义

读取一笔当前身份可见退款的权威快照、交付锁和可取消性。它只请求一次，不轮询、不改变退款状态。

**上游：** `refund create`、`refund list` 或之前的 `refund watch`。  
**下游：** 非终态进入 `refund watch`；终态结束；`can_cancel=true` 时用户可另行选择取消。

## 语法与参数

```bash
itpay refund get <refund_request_id> [--json]
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `refund_request_id` | 是 | Refund Owner 返回的退款 ID。 |
| `--json` | 否 | 输出稳定 JSON 信封；未指定时输出相同事实的简洁文本。 |

## 标准输出

```json
{
  "status": "shown",
  "result": {
    "refund_request_id": "<id>",
    "order_id": "<order_id>",
    "decision_mode": "automatic",
    "refund_status": "accepted",
    "consumption_state": "unconsumed",
    "access_locked": true,
    "can_cancel": true
  },
  "instruction": "退款处理中，交付已冻结；不要 reveal、授权或读取结果。",
  "next": {
    "command": "itpay refund watch <refund_id> --json",
    "reason": "跟踪同一退款"
  },
  "recovery": []
}
```

`decision_mode` 为 `automatic|manual`；`refund_status`、`consumption_state`、`access_locked` 和 `can_cancel` 均直接来自 Refund Owner。文本输出显示同一组字段、instruction 和最多一个 next。

## 终态

- `succeeded`：instruction 明确“退款已成功；交付永久关闭”，`next=null`。
- `cancelled/rejected`：说明交付资格可恢复，但旧 grant 不复活，需要用户重新授权，`next=null`。
- `failed`：是否继续锁定以 `access_locked` 和 `failure_class` 的服务器裁定为准，`next=null`。

CLI 不因为退款终态自行修改订单或 grant。

## 异常处理

不存在和不属于当前账号的退款都返回不透明 `not_found`。错误 instruction 要求核对当前账号/Agent 绑定，唯一恢复入口为 `itpay services list --json`；不得通过错误差异探测其他账号退款。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 返回完全相同的退款事实、instruction 和 next。Host 不改变 Refund Owner 状态或访问锁。
