# itpay buy

用于用户明确请求的普通多服务Cart购买。服务-backed行由当前cart next返回其服务动作；普通选择不绕过真实购买同意。

```sh
itpay cart next --json
```

随后使用返回的完整buy命令及参数（--help为当前参考）。它准备或恢复原官方Checkout，不自动请求付款。展示与付款事实规则见正式Skill，独立Cart用途见cart-checkout。

## 当前参数

```text
--host <host>                   client host (terminal, telegram, feishu,
--target <target>               chat id / channel id / open id for IM hosts
--item <catalog_item_id>
--variant <catalog_variant_id>
--offer <offer_id>
--cart <cart_id>                existing canonical server cart id
--quantity <n>                  quantity (default: "1")
--ref <client_reference_id>
--contact-email <email>
--contact-phone <phone>
--require-contact <fields>      comma-separated required contact fields:
--qr-format <format>            unicode|utf8|ansi|terminal
--qr-file <path>                explicit QR file path
--locale <locale>               payment card language: zh-CN|en (default:
--pay                           explicit controlled integration only; creates a payment intent
--method <alipay|wechatpay>     payment method for --pay (default: "alipay")
--no-wait                       do not wait after an explicitly authorized --pay
--timeout <seconds>             max seconds to wait for payment (default:
--json                          output JSON instead of terminal text
```
