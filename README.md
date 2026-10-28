# ItPay CLI

一个 `itpay` 入口，两种按需读法。CLI、命令注册、打包与随包Skill的唯一源码在 `itpay-ai/cli`；API Hub和Services/Payment分别由独立Hub与compose-v4维护。

- 办事、铁路/其他服务、订单和已购内容：读 [Services Skill](skills/itpay/SKILL.md)，按需 `itpay services --help` 或 [Services索引](docs/cli-reference/index.md)。无需先读API维护文档。
- 发现/调用API、用量与Hub任务恢复：读 [API Skill](skills/itpay-api/SKILL.md)，`itpay api --help` 和 [API参考](docs/cli-reference/api.md)。无需先读Services铁路教程。`hub`是同一API注册的兼容别名，首选api。

共用登录账号不代表资源、scope、设备登记、consumer或业务同意可互换。每次命令保留真实宿主声明、同Backend/Hub端点与获准状态目录；不清身份、换宿主或重建未知任务恢复额度。

2026-10-28记录的源码/固定候选版本为2.1.56，该轮未发布新版本；后续版本按正常[发布流程](docs/RELEASE.md)及当前授权管理。本地候选包含两份Skill和API参考页：`itpay skill show itpay`读取Services，`itpay skill show itpay-api`读取API；两者均返回完整原文。API不使用Services覆盖目录。隔离安装检查不代表npm next/latest已更新或真实宿主体验通过；最终包来源/hash以配套source.json为准。

维护者：[架构](docs/ARCHITECTURE.md)、[合同](docs/CONTRACTS.md)、[开发](docs/DEVELOPMENT.md)、[发布](docs/RELEASE.md)、[测试](docs/TESTING.md)、[待办](docs/BACKLOG.md)。2026-10-28三产品源码整理已正常PR合并，部分真实子路径完成；购买/履约、自然宿主及完整旅程仍未验收。本地help/包检查和main合并均不代表服务器已部署或完整验收通过。

## 维护任务入口

维护者首次读 [AGENTS](AGENTS.md)，再按[任务导航](docs/DEVELOPMENT.md#按任务开工)找到owner、修改位置与验证。用户使用Services或API各自Skill即可。服务端部署组合在[V4部署矩阵](https://github.com/itpay-ai/compose-v4/blob/main/docs/DEPLOYMENT.md#可选源码组合与支持边界)：Hub为主、Services为主、完整组合的依赖和未支持项分别列明；源码合并不表示已部署。
