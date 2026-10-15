# `itpay services list`

读取当前设备／账号可见的有限可恢复执行摘要，不是完整历史或批量时间线。

```bash
itpay services list [--limit <number>] [--json]
```

`--limit` 默认10，范围1–100整数。结果保留服务端 updated_at 降序，返回 executions、limit、returned_count、scope 和 completeness=unknown；每项附当前 reader。文本和 JSON 表达相同事实，不返回凭据或完整内部DTO。

`next=null`：一条记录不能证明唯一任务，空列表不能证明超时创建未发生。按原任务已知ID或权威关联选 reader；没有关联就停止，不自动选最新、不自动重发或新建。参数由 Agent 修正；认证、兼容和外部故障采用当次专门说明，不把 readyz 或重装当业务恢复。
