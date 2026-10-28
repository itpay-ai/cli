# CLI 发布与制品

独立CLI仓是唯一发布源码家。版本和next/latest按当前任务明确批准的候选/渠道管理，不将某次2.1.56候选或旧整理阶段限制固化为未来禁令，也不把历史批准延续为无限授权。构建、PR合并、部署、Actions与npm操作各自核对授权；编码或合并批准不自动批准发布。

源码修改后，先读目标 `.github/workflows/cd.yml`、源策略与[Actions政策](../.github/ACTIONS_POLICY.md)，明确workflow/ref/完整source SHA/渠道/包hash及下游费用，再取得该次或明确批次授权。以当前工作流为准，以下是其已有入口，不是执行批准。

## Current publication contract

`@itpay/cli` publishes from GitHub-hosted Actions using OIDC, with no `NPM_TOKEN` in the workflow. Read the current `cd.yml` before merging. GitHub environment `npm-publish` allows only `main`; it has no per-run human approval.

One-time npm package Settings → Trusted publishing setup:

- Provider: GitHub Actions
- Organization/user: `itpay-ai`
- Repository: `cli`
- Workflow filename: `cd.yml`
- Environment: `npm-publish`
- Enable **Allow npm publish** and **Allow npm dist-tag**. Stage-only permission does not permit unattended direct publication.

The package repository URL must be `https://github.com/itpay-ai/cli`. The workflow pins npm 11.21.0, which supports both OIDC publish and dist-tag. npm-side setup requires an authorized maintainer and may require one-time interactive authentication. Never claim setup complete merely because YAML is merged.

## Choose the channel explicitly

| Intent | Procedure |
| --- | --- |
| Stage a new main version | Version bump + checks + normal main merge do not publish. After approval, manually dispatch stage/source=main to `candidate-dev`; `next/latest` remain unchanged. |
| Stage a maintenance candidate | First review the internal commit and artifact. Approve its exact SHA/version/API/tarball SHA-256 in `scripts/npm-release-sources.json` on main. Dispatch action `stage`, source `dev` or `prod`; null entries fail closed. |
| Activate dev channel | Verify matching Backend/runtime/publication; approve exact dev source in policy. Dispatch `promote`, tag `next`, exact version. |
| Activate stable channel | Validate the precise approved production combination in isolation and deploy its matching Backend. Approve exact prod source, then dispatch `promote`, tag `latest`, exact version. This is not automatic main-to-production promotion. |
| Verify OIDC without publishing | Dispatch `verify` for the current exact `next/latest` value; reasserts the same tag only. |

The trusted workflow always runs on protected main. Its source selection is an enum, never a caller-supplied ref. Main policy fixes internal maintenance commits and tarball hashes; changing those approvals requires a normal reviewed main PR. Do not swap main's product tree to publish an older API.

`candidate-dev/candidate-prod` are staging labels, not user installation channels. Only `next` serves dev; only `latest` serves production. A workflow-only change with unchanged package version does not publish or move final tags. Existing versions cannot be overwritten. On an uncertain npm result, inspect exact metadata, gitHead, integrity and tags; wait read-only for visibility, do not repeat publish or invent an authentication failure. Never run a second local publisher concurrently.

## Checks and evidence

`node --test scripts/npm-release.test.mjs scripts/npm-release-source.test.mjs` checks source and channel routing. The prepare job has read-only repository permissions, no npm environment or OIDC. It checks the exact approved checkout with `npm ci` and `npm run check`, then the trusted packer records source gitHead, compiled API, version and SHA-256. No candidate build script runs in the publish job.

The protected publish job checks out trusted main only, verifies downloaded artifact source/checksum/package metadata/compiled API, and publishes that exact tarball with scripts disabled. The artifact package records the actual source SHA as gitHead; this can differ from GITHUB_SHA (workflow revision). Promotion downloads the registry tarball from registry.npmjs.org, verifies the approved SHA-256 and registry integrity, and reads its actual gitHead/version/compiled API before moving a final tag. Do not bypass checks. No new dependency.

After each release, record workflow run, trusted main workflow SHA, actual source SHA, manifest/tgz SHA-256, action/channel/version, registry gitHead/integrity and dist-tags; verify installation in a temporary prefix, Skill and Buyer docs. For next, check latest did not move. Do not silently replace a user's global CLI or device identity.

An OIDC verify run exchanges GitHub identity for a temporary npm token and sends an actual same-value tag PUT; npm dist-tag add alone skips unchanged tags and cannot prove write permission. This proves tag permission only. `npm publish --dry-run` does not prove live publish authorization. The next authorized new-version release must confirm actual publish and provenance. Preserve the old unused NPM_TOKEN secret until OIDC publication has been verified; remove it afterward with account authorization. Do not add it back as a hidden fallback.

## 本地候选与最终配套

`npm run test:package`实际构建并在私有临时前缀安装验证，忽略安装脚本；源码版本/API身份、Skill/Buyer JSON/reference/许可与编译产物必须一起检查。记录npm pack tarball的绝对路径、SHA-256、integrity、源SHA；从同包读version/help，不把package.json版本当实际安装证据。

本地候选已接通两份Skill和API参考页入包与读取，实包检查须核对原文/名称/摘要、Services覆盖兼容、API覆盖隔离、缺失/篡改拒绝、读取无网络及身份无变更。先提交源码并核工作树干净，再从该SHA构建获准版本的未发布候选，记录SHA-256/integrity并由消费者显式更新固定来源；不覆盖先前交付包，不向npm同版本重复发布。历史cddf包不含新增API文档，其旧证据不能套到新包。

正常发布使用已审定的单一路径；OIDC/网页登录/账户准入以实际工作流及npm结果为准，不猜当前授权、不在聊天索取凭据。主版本合并不会自动发布；latest生产默认与next预览分开，默认宿主渠道跟随获准的生产latest，dev只走testing-setup/明确候选。同步下游是另一个明确批准批次，不借npm权限代替跨仓权限。没有变化不重复创建推送或发布。

发布后核registry渠道、原包hash/gitHead/integrity、全新临时安装的版本/编译/Skill/文档与配套Backend/publication；latest是否变化单列。没有真实宿主自然测试就写未观察；未通过不宣传稳定可用。2026-10-28真实子路径及剩余购买/履约/宿主验收见[测试](TESTING.md)和[待办](BACKLOG.md)，不因源码合并销账。

本轮Block V（2026-10-28）无发布：固定2.1.56下载包source3245354保持，a261e99只用于同原state的一次generic请求恢复。源码/文档HEAD、未发布dist与已分发包必须分列；推送PR不重新打同版本包，不移动candidate/next/latest。完整旅程未验完，见TESTING/BACKLOG。
