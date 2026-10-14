# itpay services next

```sh
itpay services next <execution_id> --timeout 60 --json
```

读取同一执行及其当前适用动作。--timeout 为0–120秒，默认0；已有有用结果、真人操作或终态会提前返回。跨命令累计自动等待最多120秒，耗尽时 next=null，recovery仅在用户明确要求时执行。仍处理中不是零结果。

结果目录/详情/分页及购买输入由当次返回直接给出。照完整模板读写，不手写解析器、不重查、不串联旧下单命令。查询和购买同意遵循正式 Skill 与 rail-booking。

## 当前参数

```text
--since-snapshot <snapshot_id>  delta read: suppress the journey payload when
--timeout <seconds>             wait up to 120 seconds for a useful result on
--json                          output JSON instead of terminal text
```
