# CLI 架构

本仓是唯一CLI源码家。`src/main.ts`保留Services、订单、内容与账户命令；`src/commands/api_commands.ts`统一注册api及hub兼容别名；`src/client/hub.ts`是固定SDK的薄配置层。API使用独立Hub合同/SDK，Services运行owner在V4；不能为宿主复制业务状态机或直接解释供应商结果成付款/权限事实。

Services设备状态与Hub OAuth/Key、task ledger分别按当前端点保存。共同的ITPAY_STATE_DIR只提供受控存储位置，不把不同issuer/resource/token合并。真实Agent Type、Backend、Hub URL、launcher和状态目录在每个命令继承；setup参数不保证下个shell已继承。

`skills/itpay`是Services入口；`skills/itpay-api`面向API任务。按需reference提供参数，Buyer JSON为正式运行输入，不能当旧报告清除。源码Seller能力不等于当前Buyer安装包开放sell；不在正常帮助引导未打包入口。

构建为Node18+ Buyer ESM，发布制品包括正式Skill/Buyer JSON/按命令参考和许可声明；Hub SDK从dependencies固定tgz打入bundle，没有可编辑vendor副本。机器声明在package/lock、SDK.source.json和release_identity.ts，文档不改这些版本。两份Skill和API参考页均入本地候选；API reader独立校验包内摘要/名称并忽略Services覆盖目录，不写身份或访问网络。未完成的自然体验见[待办](BACKLOG.md)。

删除前检查注册、CLI内部reader、随包文件清单、包测试和现有用户恢复状态；命令别名与字段不能仅靠文档消失。owner边界和变化规则见[合同](CONTRACTS.md)。
