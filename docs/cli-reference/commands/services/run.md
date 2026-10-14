# itpay services run

执行公开定义返回的当前 operation 或继续原执行。先读取该定义/原结果提供的完整 input_template；复制 file_content 到文件，只填声明的缺失字段。

```sh
itpay services run <service_id> --operation <operation_id> --input-json <file> --json
```

公共 operation 文件有外层 input，并按返回保留 continuation。已有执行加 --execution <execution_id>；购买确认文件的形状由 purchase 模板决定，不能混用。

--timeout 控制本次等待（默认120秒，0表示立即返回）；查询累计自动等待由原任务日志记录，恢复不重置。读取 status/result 和当次 next；没有可执行动作就停止。完整铁路路线理解见 rail-booking；必要购买同意见正式 Skill。创建结果未知不自动重发，已知执行编号必须保留。

## 当前参数

```text
--operation <operation_id>  operation declared by the public service
--input-json <file>         JSON object containing the service input
--execution <execution_id>  resume the same execution
--timeout <seconds>         maximum wait before returning current progress
--host <host>
--target <target>
--json                      output JSON
```
