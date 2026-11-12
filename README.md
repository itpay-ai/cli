# ItPay CLI

本仓维护同一安装的 Services 与 API 命令和两份随包 Skill；服务端身份、账务与授权仍由各自 owner 管理。

开发安装和升级唯一入口：[dev.itpay.ai/agent](https://dev.itpay.ai/agent)。本次 npm next 版本为 **@itpay/cli@2.1.69**；公开安装入口目前仍固定 **2.1.68**，不因 next 更新自动改变，不再供应独立候选包。新 CLI 连接使用一张统一确认页：主项与默认勾选、可取消的副项，Agent 展示链接后自行等待并继续原任务。已有凭据和已受理/unknown 请求保留原身份与恢复动作。

可以打开钱包购买 credit，也可以告诉我金额，我直接给你扫码付款。

用户报金额即按现有合同准备自定义购买 credit；四档只是快捷项。给钱包/码链接时说明“当前账号：名字 · 末6位”；网页当前账号与同单购买 credit 卡到账账号分别以各自可信事实为准。两个托管 MCP 仍各自在宿主完成正常 OAuth，不互换 token/resource/grant。

[维护入口](AGENTS.md) · [开发/合并规则](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [合同](docs/CONTRACTS.md) · [部署](docs/DEPLOYMENT.md) · [测试方法](docs/TESTING.md) · [待办](docs/BACKLOG.md)

## Credit

用户购买和消费的计价单位是 credit，1 credit = ¥1。美元付款按订单汇率换算为等值 credit；实际法币付款金额和获得的 credit 以服务器冻结报价为准。购买 credit 不增加调用权限或消费预算。

Users buy and spend credit: 1 credit = CNY 1. USD payments convert to equivalent credit at the order exchange rate. The frozen server quote determines the fiat payment and credit received. Buying credit does not grant API permissions or increase spending budgets.
