# ItPay CLI

本仓维护同一安装的 Services 与 API 命令和两份随包 Skill；服务端身份、账务与授权仍由各自 owner 管理。

开发安装和升级唯一入口：[dev.itpay.ai/agent](https://dev.itpay.ai/agent)。开发版为正式 npm 包 **@itpay/cli@2.1.68**（next）；该入口安装同一正式版本，不再供应独立候选包。新 CLI 连接使用一张统一确认页：主项与默认勾选、可取消的副项，Agent 展示链接后自行等待并继续原任务。已有凭据和已受理/unknown 请求保留原身份与恢复动作。

可以打开钱包充值，也可以告诉我金额，我直接给你扫码付款。

用户报金额即按现有合同准备自定义充值；四档只是快捷项。给钱包/码链接时说明“当前账号：名字 · 末6位”；网页当前账号与同单充值卡到账账号分别以各自可信事实为准。两个托管 MCP 仍各自在宿主完成正常 OAuth，不互换 token/resource/grant。

[维护入口](AGENTS.md) · [开发/合并规则](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [合同](docs/CONTRACTS.md) · [部署](docs/DEPLOYMENT.md) · [测试方法](docs/TESTING.md) · [待办](docs/BACKLOG.md)
