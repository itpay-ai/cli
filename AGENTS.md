# CLI 维护 Agent 入口

三产品均在维护：Services/Payment/身份在 compose-v4，API Hub/唯一钱包在 itpay-api-hub，CLI/随包Skill在 cli。每组件只有一个可编辑源码家；跨仓只消费固定合同/SDK/制品，不复制运行源码或手改 vendor。

保留已有修改、真实身份、权限、原单和未知结果保护。删除能力前列替代实现、全部调用方和验证；合同与版本兼容先行。main 经 PR，不绕保护。证据区分源码核对、组件检查、隔离集成、真实宿主与发布。

按 Charlie 规则，明确隔离的测试库不做备份流程；真实用户数据、真实资金、生产/V3及其备份/迁移目录是例外，须明确授权并保护恢复能力，不能把测试规则套给真实库。源码整理不授权清数据。

当前整理阶段不部署、不触发 Actions、不发布 npm。Actions 每次或明确批次须单独批准，见 [.github/ACTIONS_POLICY.md](.github/ACTIONS_POLICY.md)；不把一般编码授权当运行批准。发布、next/latest、真实交易分别授权。详细规则见下表，不在此重复业务指南。

| 任务 | 必须阅读 |
|---|---|
| 首次进入、改模块或删除能力 | [架构](docs/ARCHITECTURE.md) |
| 接口、授权、状态、SDK变更 | [合同](docs/CONTRACTS.md) |
| 实施、检查、PR、清理 | [开发](docs/DEVELOPMENT.md) |
| 测试或验收 | [测试](docs/TESTING.md) |
| 安排未完成工作 | [待办](docs/BACKLOG.md) |
| 打包、渠道或发布 | [发布](docs/RELEASE.md)及目标工作流 |

用户Agent按README选择Services或API Skill，不必通读维护文档。
