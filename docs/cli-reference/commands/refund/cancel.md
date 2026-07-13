# `itpay refund cancel`

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

不可取消时输出到 `stderr` 并以非零状态退出：

```json
{
  "status": "error",
  "error": {
    "code": "refund_cancellation_too_late",
    "message": "refund cancellation is too late"
  },
  "instruction": "取消未生效；以 Refund Owner 当前状态为准，不要重复退款或自行解除交付锁。",
  "next": null,
  "recovery": [
    {
      "command": "itpay refund get <refund_request_id> --json",
      "reason": "读取当前权威状态"
    }
  ]
}
```

出现 `not_found` 时同样只恢复到同一退款的 `refund get`，不借错误差异探测其他账号。取消成功只恢复重新申请交付授权的资格；旧 grant 永远不会复活。

## Agent Type / Host

`codex-desktop`、`codex-cli`、`claude-code-desktop`、`claude-code-cli`、`workbuddy` 五种 Agent Type 的业务字段、instruction 和 recovery 相同；该命令没有二维码或宿主渲染差异。
