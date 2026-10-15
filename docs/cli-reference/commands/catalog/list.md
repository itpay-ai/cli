# `itpay catalog list`

读取已发布服务与公开操作，不运行服务、不创建资源。用户已有任务时沿原执行恢复，不重新发现一遍目录。

```bash
itpay catalog list [--json]
```

返回 catalog_version 和服务摘要：公开 definition 包含服务名、用途、版本、entry、operation角色／价格及是否需要continuation。查询免费不等于票款免费；报价以当前确认材料为准。不存在定义时不猜operation或价格。

只有一项服务时 next 可提供该服务的完整入口，仍须匹配用户意图；多个服务时 next=null，由 Agent 根据原需求选当前 entry。不把带 service_id 或 agent_type 占位符的示意命令当成可执行next。空目录结束读取，不自动重试或猜ID。

输出不含manifest原文、供应商凭据或内部工作流。当前参数与实际错误来自help／运行返回；所有宿主目录事实一致。
