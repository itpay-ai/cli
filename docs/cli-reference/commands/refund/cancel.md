# `itpay refund cancel`

> **Product boundary:** `itpay` is the single public CLI entry point, and `$itpay` is its user-facing Skill invocation. The public package provides Buyer workflows; Seller authoring source is maintained separately.

## 范围与意义

在 Refund Owner 允许时取消 active refund。取消成功后释放访问锁，但不复活旧 Agent grant。

**上游：** `refund get` 显示 `can_cancel=true`。
**下游：** `order` 或重新进行用户授权。

## 语法与参数

```bash
itpay refund cancel <refund_request_id> [--reason <reason>] [--json]
```

`--reason` 默认 `buyer_cancelled`。

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `<refund_request_id>` | 是 | `refund create/get/watch` 返回的退款请求 ID |
| `--reason <reason>` | 否 | 取消原因；默认 `buyer_cancelled` |
| `--json` | 否 | 输出单个标准 JSON envelope |

该命令使用当前设备的签名 Agent Device session。Refund Owner 会校验退款是否属于该设备已绑定的订单，并决定当前状态是否仍可取消；CLI 不自行释放访问锁。

## 标准输出

```json
{
  "status": "cancelled",
  "result": { "refund_request_id": "<id>", "order_id": "<order_id>", "access_locked": false },
  "instruction": "退款已取消；如需交付，重新进入订单并取得新的授权。",
  "next": { "command": "itpay order <order_id> --json", "reason": "确认订单访问状态" },
  "recovery": []
}
```

取消是否生效按当次服务端状态说明；结构化错误在当前文本／JSON出口返回，不承诺一定已取消，不重复提交或自行解除锁。取消成功只恢复按当前订单核对权限的资格，旧grant不自动复活。

## Agent Type / Host

所有正式支持的 Local Agent Type 的业务字段、instruction 和 recovery 相同；该命令没有二维码或宿主渲染差异。
