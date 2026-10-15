# `itpay services start`

## 读取服务入口

从 `catalog list` 选择公开 service_definition，读取固定版本的总览、声明操作和完整输入模板。公开总览不创建 execution、不调用 Provider；不要把读取总览当作已查询库存。

```bash
itpay services start <service_id> [--host <host>] [--target <target>] [--json]
```

`service_id` 来自当前目录。`--host` 对应实际宿主，`--target` 是该宿主需要的稳定消息目标，不是业务输入。Buyer、Device 和 Agent instance 来自签名会话，不可通过参数覆盖。

本命令不接收业务输入。使用返回的声明操作与完整 `input_template.file_content` 写 JSON 文件，再执行该模板的 `services run --operation … --input-json <file>`；保留外层 `input` 与返回的 continuation。占位模板须填入实际值后执行，不猜字段或 operation。

铁路首次实际查询前按 `rail-booking` 理解完整端点、用户锁站与约束，必要时短查，留下2–4行路线摘要，再查询。查询结果、详情和整程购买沿当前返回动作继续；购买仅补缺失的真实同意。

只使用当前返回的合法动作。缺少声明合同或不兼容时保留原执行并停止，不绕过检查创建替代执行。免费额度上限不是当前剩余额度；登录、权限与外部故障按实际错误恢复。
