# CLI 当前待办

| 未完成项/影响 | Owner | 证据与退出条件 |
|---|---|---|
| API Skill/reference尚未入包或被skill命令读取 | CLI/Planning | package.files仅含原Services Skill；src/commands/skill.ts只识别itpay。下一配套批明确白名单修改打包/reader/检查，保留Services行为，重打未发布同版本候选并在V4更新hash。旧cddf包不包含本批新说明。 |
| V4 Services整体装配未完成 | V4 Services | 当前只有查询/模型与Collection gateway等组件恢复；需业务、身份、持久化、worker与正式页配套，不以help成功宣称可买。 |
| 当前候选真实Services/API两条独立Agent体验未观察 | Testing | 固定最终包与服务器组合后分别自然操作，记录帮助/约束/恢复/展示。 |
| WorkBuddy OAuth、dev切换及原付款后交付/支付宝回调问题 | Identity/Payment/Services | 保留已登记范围；本批不改认证或环境，不以文档修改销账。 |
| 两类Skill与按需帮助内容最终制品一致性 | CLI发布维护者 | 重打候选后核实际安装文件，版本/编译/Skill/Buyer JSON/reference及下游固定包SHA，获准再发布；latest不变。 |
| 源码树中的旧模块/测试README尚不在本批白名单 | CLI维护者 | src/*/README.md、tests/README.md以后按实际owner导航核对；本批不为删说明改运行代码。 |

Services Skill原本已是独立Services流程，本批保留原字节及其canonical摘要；API的独立选择由README/索引及新API Skill说明，不为改标题牵动白名单外生成代码。若下一批修改Skill，必须沿build-buyer.mjs原生成链同步src/state/skill_identity.generated.ts；不能手填hash或把文档HEAD直接当冻结包。当前检查产物仅用于本地smoke，不替换已交付cddf候选。

当前按命令参考页保持全部已注册Buyer命令；sell页和旧渠道rollout/NPM_RELEASE报告已删除，发布规则并入RELEASE.md。src模块/测试README、发布脚本、package/lock与机器Buyer文档未改；不宣称全仓治理已经强制生效。
