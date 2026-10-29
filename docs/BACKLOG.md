# CLI 当前待办

## 基础可用核查（2026-10-29）

只区分CLI实现、实际发行和自然宿主三种事实。10月28日[TESTING](TESTING.md)记录的固定2.1.56/未发布候选是历史，不代表当前仍未发布。当前发行合同见[RELEASE](RELEASE.md)；本次BACKLOG审计不运行Actions/npm、不改版本/业务/用户state。

### 已完成、避免重复派工

| 范围 | 证据与限度 |
|---|---|
| 两份Skill/帮助与独立直HTTP/SDK链 | Services→Backend；API→固定Hub SDK→Hub API，CLI不经MCP。两Skill/reference/Buyer docs/原身份隔离测试及实包检查已接通，不再列为源码缺失。 |
| 授权/预算错误不制造零元付款、地点选择actor、token-free账号入口消费 | a261e99、CLI58及[PR127](https://github.com/itpay-ai/cli/pull/127)相继交付；真实dot/muse在bearer检查前消费验证过的accountentry，其他宿主原bearer链保留。V4PR43修复对应后端全部bound宿主误返accountentry；四宿主离线配对正向/无bearer负向区分，不宣称真实宿主全过。 |
| 2.1.59 next及固定setup来源 | [版本PR128](https://github.com/itpay-ai/cli/pull/128) source59b0086e1133b9d10a26ee3703ce7591d3bee825；[policyPR129](https://github.com/itpay-ai/cli/pull/129)；[promote40874769293](https://github.com/itpay-ai/cli/actions/runs/40874769293)成功。next/candidate-dev2.1.59，latest/candidate-prod2.1.41。SHA2568f9527b781c0fe2f283391dd1e00045b48bcefff8fa2e738f76982cbe86536d1；registry/Actions/公开setup下载同字节，隔离安装75文件/两Skill核过。 |
| 发行首次即时tagcheck失败准确保留 | stage40873276881 prepare完整检查通过、npm接受且签provenance；因registry处理中即读标签未收敛标失败。未重发，等metadata/gitHead/integrity/原包验证后正常promote，不把失败run报告成全绿。 |

### P0/P1：确认问题与待判阻断

本轮未确认CLI新增安全/资金P0；宿主/资源隔离和unknown保护仍为硬约束。

| ID / 影响 | 唯一owner | 退出条件 |
|---|---|---|
| U02 账号登录裸QR及account-checkout仅链接，两条品牌卡接线缺失（确认P1） | V4官方资产owner；CLI account_auth消费 | account_auth.ts两处裸512PNG；commerce.ts Dot/Muse在原a0ed5fe1已有仅链接return，CLI59未补品牌字段，用户要求QR后目标自编码不是正式资产。复用现有auth/payment HTML→截图PNG链，V4按原session/checkout/期限及现有认证供资产，CLI真实host消费；不新POST、不外泄poll/browser凭据、不把办理页称付款。缺图回原URL，不让Agent自画；真实Muse分别目视授权与办理/支付卡。新版本另批。 |
| 全入口裸码/失败重画及阶段说明（P1确认） | CLI render/各command/两Skill | terminal.ts始终ASCII且品牌失败writeLocalPNG，checkout/services直接renderTerminalQR，Vault terminal同样裸码；API上层brand保护仍落公共terminal，须一并收口。只正式品牌HTML/同HTML图或原官方链接，禁止Agent自编码/裁品牌；用途/状态/本人动作/原next用现有envelope表达，原pay/buy image来源待核，不把字段名当品牌证明。两Skill/帮助同步，不以只改Skill当修复。 |
| R01原补偿资金已完成，Agent售后读回未过（P1） | V4 Refund/订单读模型；CLI消费原返回 | OLD80-REFUND-ACCEPTANCE记录rr_12b5…原80元现金succeeded/用户退款详情通过；target读回报supplier_refund_confirmation_required、拿不到实际结果，订单取消仍出票中/全退称部分。按T08只读原refund→order→Agent响应定位；不伪报CLI已修、不重跑退款、不触发真实售后，第二单/供应商退票/充值退款未销。 |
| S05 Muse59正式页404（阻断P1，根因待判） | V4 Identity/Checkout | CLI59已交无token原URL；浏览器browser-entry404，checkout/execution/deviceowner一致但Safari session未知。不能通过CLI换身份、伪造token或重复授权绕过；等待正常owner根因证据。 |
| U01 默认用户登录落Hub/用户中心缺失（确认P1） | V4 Web | CLI不复制用户首页或Hub Console，不用修改AgentType/Backend绕页面owner；保留原checkout/OAuth返回，显式Hub入口。 |
| S02 地点ground、R02/R03模拟售后闭环 | V4 Planner/RailAftercare | 真实ground采集/出站依据和合法fake退票/改签事实源，不用CLI文案假补数据或“已完成”。 |

### P1：未验收项，先Testing

| 目标 | owner | 最小退出条件 |
|---|---|---|
| 当前固定包Services自然旅程 | CLI消费/独立Testing，V4业务owner | 原Muse保持device/instance/ITPAY_STATE_DIR；选择/报价/实际同意/官方页/模拟付款/逐腿出票/用户领取；2.1.59已升级不代表整条通过，当前S05首错保留。 |
| API独立自然Agent | CLI API / Hub / Testing | 只读API Skill，discover→inspect→原pub调用→结果/usage；不足→本人假充值→原request resume一次，撤销到期拒绝。不用主持CLI的¥0.01子链代签。 |
| 宿主实际展示与严谨授权 | CLI实际Host/原后端权限 | dot/muse accountentry无bearer读取/持久化；Codex/WorkBuddy合法Backend响应沿原bearer/card/native；无入口/无bearer负例仍拒；OpenClaw仍需可信target，不扩大scope。 |
| 领取/售后及原任务恢复 | V4订单/售后、CLI只按合同 | 已有用户凭证下载不等Agent grant；late-cash/已出票退款/改签事实分开；unknown原ID只读，不换key/重run；真sourceexpiry仅原owner允许的新query模板，automaticfalse。 |
| 两MCP配对与安装 | V4用户MCP / Hub MCP / Testing | 不经CLI来替MCP签授权/工具成功；各自issuer/resource/client/grant及list/call、撤销/到期独立验收。 |

### P2 集中列表

| 项目 | owner | 退出条件 |
|---|---|---|
| managed购买模板与legacy逐腿凭据混显/expiry unknown | CLI src/services/rail/results.ts；V4仅供事实 | 可读原managed授权引用，不将其无legacyoffer误称不可购买；期限缺事实保持unknown、不伪造。 |
| recovery_required外running、空结果分页/短GET写操作文案 | V4状态 / CLI展示各自owner | 原事实和next不误导、不重复效果；若导致基本不可恢复升P1，不隐藏错误。 |
| device status帮助和src/tests模块README旧导航 | CLI维护者 | 对应现已注册命令/唯一owner，保护机器Buyer输入/许可证/有效测试，不为文档整理改协议。 |
| 非关键Host文案/间距 | CLI render / 对应页面owner | 实际可见官方入口和金额不变；品牌授权卡和关键手机操作仍P1。 |

WorkBuddy旧未登记设备映射已有V4PR34修复及自然setup_ready/device ready反馈；白名单/后续账号和购买需真实结果，不清旧私钥/state重建。支付宝后台、独立Payment商户/双域入口、生产latest/真实资金与票、所有平台上架及高级商户能力按既有裁决后置；本CLI审计不借版本59批准扩发60或更新全局安装。

## 历史整理记录（以下为10月28日及当批事实，非当前发行状态）

当前按命令参考页保持全部已注册Buyer命令；sell页和旧渠道rollout/NPM_RELEASE报告已删除，发布规则并入RELEASE.md。src模块/测试README、发布脚本、package/lock与机器Buyer文档未改；不宣称全仓治理已经强制生效。

两份Skill及API参考页本地候选检查已接通；Services原文、别名、覆盖校验保持，API独立摘要/名称校验且不读Services覆盖目录。Skill读取无网络/身份写入的隔离实包断言不等于自然Agent旅程。npm发布、部署及真实宿主观察仍未完成，也不由本批授权。

2026-10-28：a261e99已修授权/预算误呈现零元付款，原generic请求一次resume收费成功（主持CLI/UI，不代签自然宿主）；余额不足充值恢复未验。独立Payment双入口/测试商户由用户明确后置，WorkBuddy已登记问题不修；Services短GET超时“写操作”文案、空结果分页和recovery_required展示P2登记后置，不扩任务。

固定下载包仍3245354/2.1.56；a261e99未发布候选未更新npm/渠道或本人安装。真实readonly grant/最小admin Key已正常UI撤销，OAuth/设备state保留。fetch的main c09d7d3已在候选祖先，无未吸收提交，PR#119后来按用户批准正常合并为0105e34c，未Actions或发布；后续开发走最新main/正常PR和当前任务授权，不延续旧准备阶段禁令。本批无新增删除，旧模块README/机器Buyer输入/许可证不扩范围清理。
