# ItPay CLI

本仓维护同一安装的 Services 与 API 命令和两份随包 Skill；服务端身份、账务与授权仍由各自 owner 管理。

开发安装和升级唯一入口：[dev.itpay.ai/agent](https://dev.itpay.ai/agent)。本次 npm next 版本为 **@itpay/cli@2.1.69**；公开安装入口固定 **2.1.69**。当前 main 虽仍标同一版本，包含尚未发布的候选改动；不能从版本字符串推断能力一致。公开包不含退款命令及 `--payer-currency`；见[命令参考](docs/cli-reference/api.md)中的候选边界。新 CLI 连接使用一张统一确认页：主项与默认勾选、可取消的副项，Agent 展示链接后自行等待并继续原任务。已有凭据和已受理/unknown 请求保留原身份与恢复动作。

仅在用户明确要求为本人钱包增加 credit 并指定金额时，才准备对应官方付款。ChatGPT 只提供中性的账号状态和原请求下一步。

钱包页面与官方回执分别显示可信账号信息；四档为快捷项。两个托管 MCP 仍在各自宿主完成正常 OAuth，不互换 token/resource/grant。

[维护入口](AGENTS.md) · [开发/合并规则](docs/DEVELOPMENT.md) · [架构](docs/ARCHITECTURE.md) · [合同](docs/CONTRACTS.md) · [部署](docs/DEPLOYMENT.md) · [测试方法](docs/TESTING.md) · [待办](docs/BACKLOG.md)

## 本人钱包与 credit

用量以 credit 计量，1 credit = CNY 1 等值。实际法币金额、credit 数量及汇率以服务器冻结记录为准。钱包余额不增加调用权限或预算。

Usage is metered in credit (1 credit = CNY 1 equivalent). Fiat and credit amounts follow the frozen server record. Wallet balance does not grant API permissions or increase spending budgets.

本次仅调整源码文档与随包 Skill，尚未发布。公开 npm next 2.1.69 不含候选退款与 USD 参数；其随包 Skill、帮助及运行提示仍保留旧文案，已验候选的帮助与运行提示也未随文档改成中性提示。文档合并不等于公开安装包已更新，需在另行批准的发布范围内同步并验证；用户安装说明只适用于公开包已有功能。
