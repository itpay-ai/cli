# ItPay CLI

一个 `itpay` 入口，两种按需读法。CLI、命令注册、打包与随包Skill的唯一源码在 `itpay-ai/cli`；API Hub和Services/Payment分别由独立Hub与compose-v4维护。

- 办事、铁路/其他服务、订单和已购内容：读 [Services Skill](skills/itpay/SKILL.md)，按需 `itpay services --help` 或 [Services索引](docs/cli-reference/index.md)。无需先读API维护文档。
- 发现/调用API、用量与Hub任务恢复：读 [API Skill](skills/itpay-api/SKILL.md)，`itpay api --help` 和 [API参考](docs/cli-reference/api.md)。无需先读Services铁路教程。`hub`是同一API注册的兼容别名，首选api。

共用登录账号不代表资源、scope、设备登记、consumer或业务同意可互换。每次命令保留真实宿主声明、同Backend/Hub端点与获准状态目录；不清身份、换宿主或重建未知任务恢复额度。

源码候选版本仍为2.1.56，未发布新版本。本轮新增API Skill/参考页尚未纳入package.files及Skill命令：旧cddf0a35包不含这些新文件；下一配套批需更新打包声明/检查、重打未发布候选及消费者锁。当前 `itpay skill show itpay` 仍只读Services Skill，不能声称 `skill show itpay-api` 已可用。

维护者：[架构](docs/ARCHITECTURE.md)、[合同](docs/CONTRACTS.md)、[开发](docs/DEVELOPMENT.md)、[发布](docs/RELEASE.md)、[测试](docs/TESTING.md)、[待办](docs/BACKLOG.md)。当前V4第四批装配仍未完成；本地help/包检查不是服务器可用或真实旅程验收。
