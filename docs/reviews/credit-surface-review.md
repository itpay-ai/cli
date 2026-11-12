# CLI 命令、help、错误与回执文案复核

本表从页面/命令入口枚举全部可见文字候选，逐项决定见 [文案明细](credit-surface-copy.tsv)。[关键词索引](credit-wording-audit.tsv) 仅作为补漏，不代替入口复核。字段名、路径、授权/unknown 约束、实际法币付款与历史事实保留；credit 展示按术语表统一。

| 页面/命令/模块 | 文案候选数 | 复核决定与边界 |
|---|---:|---|
| `src/commands/admin.ts` | 7 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/aftercare.ts` | 2 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/agent.ts` | 33 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/api_commands.ts` | 84 | 逐项保留非金额/协议说明，8 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/buy.ts` | 15 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/cart.ts` | 63 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/catalog.ts` | 13 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/checkout.ts` | 23 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/checkout_handoff.ts` | 3 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/compatibility.ts` | 1 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/docs.ts` | 18 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/feedback.ts` | 29 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/first_connection.ts` | 2 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/hub.ts` | 17 | 逐项保留非金额/协议说明，3 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/hub_guidance.ts` | 8 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/install.ts` | 22 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/next.ts` | 11 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/order.ts` | 13 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/orders.ts` | 11 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/pay.ts` | 8 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/presentation.ts` | 30 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/readyz.ts` | 6 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/refund.ts` | 10 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/services/actions.ts` | 10 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/services/commerce.ts` | 31 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/services/lifecycle.ts` | 49 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/services/purchase.ts` | 8 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/services/results.ts` | 28 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/setup.ts` | 13 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/shelf.ts` | 28 | 逐项保留非金额/协议说明，5 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/skill.ts` | 17 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/vault.ts` | 18 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/vault_handoff.ts` | 17 | 逐项保留非金额/协议说明，0 项含 credit；余额、报价、扣费和到账使用 credit |
| `src/commands/wallet_topup.ts` | 9 | 逐项保留非金额/协议说明，4 项含 credit；余额、报价、扣费和到账使用 credit |

## 打开与验证记录

源码入口及上述文案已复核。候选页面通过既有 Node+Playwright fixture 与本批补充的逐页只读检查打开；实际dev完整旅程由部署后的同账号390/1440px中英文四组合核验单独签收，未部署前不冒称已通过。

Hub：`TestMarketBrowserFixture` 逐个打开目录、API详情、Console、消费/购买记录、Keys、任务、我的API和BYOK；`TestBillingPresentationBrowser` 覆盖流水/消费记录的正常、空、加载、报错；OAuth预算正常/不可用/错主体通过原 SelfServicePermissions 浏览器场景。

V4：登录、OAuth login/consent/device 的两语言/375/390/1280px使用 `apps/web/scripts/check-oauth-ui-browser.mjs`；收银台实际模拟原单成功页已有四组合记录；Services Checkout/订单/退款/领取/邮件通知保留实际法币，沿原组件测试，不虚构真实订单或发邮件。

CLI：两Skill及`api categories/list/show/call/status/wallet`、connect/credentials/doctor/admin 的help/message/description按源码与实包help逐项核对；字段的金额单位解释补充到Skill/help/报价/回执，安装类型保留main新增grok/grok-bot。实际dev原profile的免费/付费/模拟购买回执已核。

尚未覆盖的真实布局、身份或数据依赖明确在正式 TESTING 中标记，不以源码明细代签自然旅程。
