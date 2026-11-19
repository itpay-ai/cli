# ItPay CLI

本仓维护同一安装的 Services 与 API 命令和两份随包 Skill；服务端身份、账务与授权仍由各自 owner 管理。

This release is **@itpay/cli 0.2.72**. Use the official [dev installation and upgrade entry](https://dev.itpay.ai/agent), which persists existing dev settings in a launcher. The package default remains app.itpay.ai; next/latest never move profiles or original requests. Actual public availability is established by publication and installation readback.

仅在用户明确要求为本人钱包增加 credit 并指定金额时，才准备对应官方付款。ChatGPT 只提供中性的账号状态和原请求下一步。

钱包页面与官方回执分别显示可信账号信息；四档为快捷项。两个托管 MCP 仍在各自宿主完成正常 OAuth，不互换 token/resource/grant。

[维护入口](AGENTS.md) · [开发/合并规则](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [合同](docs/CONTRACTS.md) · [部署](docs/DEPLOYMENT.md) · [测试方法](docs/TESTING.md) · [待办](docs/BACKLOG.md)

## 本人钱包与 credit

用量以 credit 计量，1 credit = CNY 1 等值。实际法币金额、credit 数量及汇率以服务器冻结记录为准。钱包余额不增加调用权限或预算。

Usage is metered in credit (1 credit = CNY 1 equivalent). Fiat and credit amounts follow the frozen server record. Wallet balance does not grant API permissions or increase spending budgets.

Release 0.2.72 includes original-wallet refund and payer-currency documented in the [command reference](docs/cli-reference/api.md). Only minimum_cli and exact blocked_versions require upgrading; recommendations only advise and new capabilities are checked per operation. Hashes remain diagnostic. Preserve the original profile, permissions and pending/unknown requests.
