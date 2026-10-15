# itpay services quote

仅用于明确要求的独立多服务组合，或当前服务明确返回的动作。普通服务购买使用 services purchase。

```sh
itpay services quote <execution_id> --capability <capability_id> --input <key=value> --json
```

实际参数见 --help；使用当前 capability 合同的完整输入。Quote只锁定对象、金额、币种及期限，不代表真实同意、付款或履约。已有原记录由代码处理；Agent只执行当次完整模板和适用动作。

## 当前参数

```text
--capability <capability_id>
--input <key=value>           input to lock into the paid service quote
--email <delivery_email>
--json                        output compact JSON
```

`--input-json <file>` accepts the complete flat input returned in `file_content`; use it instead of `--input`, never together.
