# CLI 维护 Agent 入口

三产品均在维护：Services/Payment/身份在 compose-v4，API Hub/唯一钱包在 itpay-api-hub，CLI/随包Skill在 cli。每组件只有一个可编辑源码家；跨仓只消费固定合同/SDK/制品，不复制运行源码或手改 vendor。

保留已有修改、真实身份、权限、原单和未知结果保护。删除能力前列替代实现、全部调用方和验证；合同与版本兼容先行。main 经 PR，不绕保护。证据区分源码核对、组件检查、隔离集成、真实宿主与发布。

按 Charlie 规则，明确隔离的测试库不做备份流程；真实用户数据、真实资金、生产/V3及其备份/迁移目录是例外，须明确授权并保护恢复能力，不能把测试规则套给真实库。源码整理不授权清数据。

按当前任务的明确授权开发、验证和经PR合并，不沿用旧阶段禁令，也不把某次批准延续为未来无限授权。环境/部署、数据库迁移、npm版本/渠道、域名与真实交易分别核对授权范围；合并代码不自动批准这些操作。除CLI next既有专项批准范围外，Actions每次或明确批次须单独批准，见[费用政策](.github/ACTIONS_POLICY.md)，不绕分支保护、不将未运行检查标为通过。 详细开发与发布入口见下表。

| 任务 | 必须阅读 |
|---|---|
| 首次进入、改模块或删除能力 | [架构](docs/ARCHITECTURE.md) |
| 接口、授权、状态、SDK变更 | [合同](docs/CONTRACTS.md) |
| 实施、检查、PR、清理 | [开发](docs/DEVELOPMENT.md) |
| 测试或验收 | [测试](docs/TESTING.md) |
| 安排未完成工作 | [待办](docs/BACKLOG.md) |
| 打包、渠道或发布 | [发布](docs/RELEASE.md)及目标工作流 |

用户Agent按README选择Services或API Skill，不必通读维护文档。

## 任务定位

按[任务阅读与修改导航](docs/DEVELOPMENT.md#按任务开工)选择唯一owner、文件和必要验证；部署先读本仓部署/发布正文及目标workflow。Services、用户UI、两个MCP与各自卡片、OAuth、跨仓合同分别定位，不创造第三套UI MCP。新任务宿主允许且可执行CLI时优先官方固定CLI，否则按业务选择对应托管MCP；已受理/unknown保留原身份/入口/请求与授权，失败不得换入口绕权限。

Charlie已长期批准CLI next发布workflow：在已批准候选/版本范围内无需逐次申请Actions权限；不扩到新版本号、latest、V4部署或其他CI。本次文档任务不运行Actions或发布。
