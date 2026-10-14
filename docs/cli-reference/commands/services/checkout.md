# itpay services checkout

恢复已知服务的原 Checkout 时，使用当次返回的具体命令。普通已选服务通过 services purchase 准备官方入口，不手工编排报价和购物车。

参数以 --help 及当前模板为准。保留同意范围、付款期限和未知结果保护；展示权威原入口，不创建替代购买。缺材料/过期/存储故障按当前返回处理，不自行切换路径。

## 当前参数

```text
--capability <capability_id>
--input <key=value>           input to lock into the paid service quote
--email <delivery_email>
--resume                      reissue the existing checkout handoff without
--host <host>                 client host (terminal, codex, telegram, feishu,
--target <target>             chat id / channel id / open id for IM hosts
--qr-format <format>          unicode|utf8|ansi|terminal
--qr-file <path>              explicit QR file path
--locale <locale>             payment card language: zh-CN|en (default:
--json                        output JSON instead of terminal text
```

`--input-json <file>` accepts the complete flat input returned in `file_content`; use it instead of `--input`, never together.
