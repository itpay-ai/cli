# CLI 发布与制品

独立CLI仓是唯一发布源码家。正式发布1.0前只发0.2.x，当前候选0.2.88；不再发2.x。普通就绪next发布已获Owner常设批准，不需逐版重新批准；生产部署、数据迁移、latest切换与deprecate各自另批。代码经小PR、最后revision取得明确Codex Review结论后正常合并，不能把本地通过当发布完成。

## 唯一发行路径

受保护main构建一次，发布该不可变包到next。latest获批后指向同一版本，不重建同号包；不再有dev/prod独立源码或candidate制品流程。历史tag暂不改，已发版本不覆盖。

CLI内置默认始终app.itpay.ai，tag不选环境。dev官方入口通过已有profile/launcher显式选dev，原profile、身份和任务保持原环境。未升级的生产环境给明确dev入口说明，不做V3适配；不能据此迁移已受理请求。

| 意图 | 现有workflow入口 |
| --- | --- |
| 发布就绪新版本到next | main合并和独立验收完成后，dispatch `cd.yml`，action=publish，tag=next；填写Owner常设批准引用与本次原因。 |
| 晋级已发包 | Owner另批后，action=promote，明确next/latest及精确0.2.x版本；核原源码属于main历史，读取同一不可变包。 |
| 只读复核已发布 next | 明确批准后 action=readback、tag=next、精确版本。仅校验 registry 制品及 dev /agent，不使用 OIDC、不写标签。 |
| 验证OIDC写权限 | 另有授权时action=verify，只能重申当前tag对应精确版本，不移动tag；这仍是真实写操作。 |

只使用workflow_dispatch，不自动push/PR发布。按当前`.github/workflows/cd.yml`与[费用政策](../.github/ACTIONS_POLICY.md)执行；next常设授权不扩到其他workflow。未知发布结果先只读查原版本、来源与tag，不能重复publish；一个版本一次发行。回退是精确已验包/tag，安装者不会自动跟随回退，不清状态。

npm可能先接受publish再异步处理。发布后独立只读任务对原 tag 最多等待8分钟读取同一版本和来源，不再publish或改tag；403/限流等读取错误立即停止，来源不同立即停止。超时保留原run并只读核对原发布，不能根据暂未可见就重复发行。

## 制品与权限

GitHub Actions OIDC发布，仓库`itpay-ai/cli`、workflow `cd.yml`、environment `npm-publish`；npm侧Trusted publishing须已允许publish和dist-tag。没有NPM_TOKEN。Runner固定Node24/npm11.21.0；npm环境只在受保护发布job使用。仓库environment仍仅main。

prepare只读checkout同一main，运行release tests、npm ci和npm run check，再用原packer生成Buyer制品与实际gitHead。publish不执行候选脚本，核原源码、包版本和已有制品完整性，发布下载的原tarball。hash/revision作为运行时诊断，不能再用API hash相等拦业务或重新设审批门槛；来源与供应链完整性、OAuth权限继续保留。

本地npm演练仅产物目录：根/项目有package.json，每条命令显式--prefix并事前核npm prefix在产物内，隔离HOME/npmrc/cache/registry。403、挑战、限流立即停报，不换UA/路径/身份。开发安装、真实宿主、自然任务和发布安装读回分别记录，不由工程检查代签。

每阶段REPORT给PR、最终revision审查、实际包/环境、实测、实际diff；某仓净增逐段说明用途。Skill正文和参考由本仓维护，MCP/Hub SDK从独立owner固定包消费，不能手改vendor或删除许可。

0.2.75 next候选随dev统一My API规范/支持认证与已存在的明确reconnect指引；SDK/合同仍固定740/b7，未变更接口或消费算法。须最终审查后以唯一原cd.yml任务发布，实际公开安装与dev入口一致后交真实复测；源码合并本身不算已发布。

0.2.76 corrects the packaged README release drift and documents the existing npm exec entry with explicit dev settings and original profile. No runtime authentication, request or SDK behavior changes. Publish one immutable next package after final review; preserve latest.

0.2.77 includes the reviewed sequential-query task-pointer fix. The packaged README uses the supported codex-desktop Agent Type, and the outer API Skill instruction names the actual categories/list/show commands. Publish one immutable next package after final review and preserve latest; no profile, SDK, original request or grant migration.

0.2.78 carries the reviewed connection-surface and consent-scope Skill wording. Services status is not API authentication status; reconnect/revoke keeps the intended original surface/profile, and consent describes the page’s per-call limit and connection scope. No command, SDK, grant, original-task or financial algorithm changes. Publish once to next only after final review/checks; preserve the immutable77 package and latest.

0.2.79 consolidates the reviewed original API launcher guidance, browser-original wallet refund owner read, and same-profile task-conflict status next. No credential/profile migration, supplier retry, financial write, SDK update or concurrency relaxation. Publish one immutable next package after final review/checks and preserve latest.

0.2.80 carries the reviewed safe terminal-failure task release and one canonical read on a conflicting explicit new call. It preserves original receipts, compare-release/attach, unknown/held/captured-failure/recovery protection and supplier idempotency. Publish once to next after final review/checks; retain79 and latest.

0.2.81 exposes the API shelf in list and show, plus the current publication and price version IDs in show. It packages the updated API Skill and preserves the existing show-to-call freeze.

0.2.82 carries the reviewed unified connection completion output from #208. Publish once to next and preserve latest.

0.2.83 releases the local API task pointer after a definite pre-admission rejection or original-profile not-found read when no receipt was ever observed. Active receipts and unknown delivery continue to keep their original request.

0.2.84 displays the masked current Services account after the existing signed binding and account-status checks complete.

0.2.85 observes the original paid request after a write timeout, and continues the original intent after explicit Device consent. The next publish checks the public dev installer guide without deploying it.

0.2.88 prepares a fresh API task before connecting. The shown public quote then enters the existing signed confirmation from the same profile.
