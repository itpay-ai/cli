# CLI 2.1.29：用户已发布next，registry与全新安装已核对

- 独立仓库：`/Users/tzz/Documents/itpay_cli`
- 准备分支：`codex/cli-2.1.29-release-ready`
- 固定源码：`8aa60a11b24d1c8da1b2832d3e442a58c77bb760`
- PR：https://github.com/itpay-ai/cli/pull/84（2026-10-01按用户新授权已合并）
- 旧工作：`codex/cli-next-manual-release` / `3fbbb5836a683537ad96d877231c65fc9aefb28b` 保留，候选目录保留。
- tarball：`/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-cli-2.1.29.tgz`
- SHA-256：`db1fa1d6569acb5a54fe3a3bd2ea1ca41b06d582eaf1265311397efc101ee24b`
- package/config 版本2.1.29，publishConfig.tag=`next`。
- 只读 npm 观察（2026-10-01）：latest=2.1.1、next=2.1.22；2.1.29 尚不存在。发布前须重新核对，不能覆盖同版本不同内容。
- 最终 npm 包及五渠道实际 launcher、共同 Skill/12 Buyer 文档/编译文件核对证据在 Compose `implementation-evidence/artifact-proof.json` 和 `channel-archives.json`。
- 干净远端引用 checkout：lint、现有4项audit修复测试、test:package通过。test:package前必须依既有 `fetch-sell-runtime.mjs` 下载并校验锁定的正式运行时，不需要本机隐藏源码。

## 发布路径（本任务未执行）

用户选择后只走一条路径：建议用户审查并合并 #84，由现有 main CD 执行发布；合并会触发 npm publish，不能先本地发布再合并重复触发。

当前固定 tarball 可供安装和 Testing，但 package.json 内未带 gitHead。本地直接发布固定包与后续 CD 的 gitHead 幂等关系尚未闭环，因此本地发布路径不标为可无条件执行；不得忽略同版本不同 gitHead。若用户明确选择本地固定包发布，先固定发布归属和后续 CD 策略，保留原候选不覆盖；本任务不修触发器来偷偷规避规则。

CI/prepublishOnly 包含既有检查，不用 --ignore-scripts 绕过发布检查。本次未 npm publish、dist-tag、workflow_dispatch 或 CLI main 合并。

## 部署与体验限制

Compose #229已正常合并，merge `6521caab6afe929e28c7a824c622d258e96311d6` 已由既有CD部署dev；Smart v6 active、公开readyz/compatibility/manifest及运行源码已核对。固定tgz安装--version=2.1.29，Skill与12 Buyer字节一致；npm 2.1.29匿名读取仍404。本任务未发布/未合并CLI。自然登录、页面、四条流程与耗时仍由独立Testing观察；这些部署事实不等于UX通过。

## 五渠道 ZIP 与 SHA-256

```json
[
  {
    "channel": "itpay-plugin-chatgpt",
    "archive": "/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-plugin-chatgpt-2.1.29.zip",
    "sha256": "b8fdd581f50c4ccd54136eacc63c816f67c5932228808aaadd3619e245d13470",
    "archive_actual_launcher_version": "2.1.29"
  },
  {
    "channel": "itpay-plugin-kimi-work",
    "archive": "/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-plugin-kimi-work-2.1.29.zip",
    "sha256": "2d9acddc90156442fa642f10a9d761e744cf3cc23b5537959e1998a672b4e819",
    "archive_actual_launcher_version": "2.1.29"
  },
  {
    "channel": "itpay-skill-hermes",
    "archive": "/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-skill-hermes-2.1.29.zip",
    "sha256": "50a0b726f8cb25ed6f7e61e286e0e3e990c7864813fd3f46d6b9d31e4b910909",
    "archive_actual_launcher_version": "2.1.29"
  },
  {
    "channel": "itpay-skill-openclaw",
    "archive": "/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-skill-openclaw-2.1.29.zip",
    "sha256": "10e9a83e8ac2b31f0f06f832a55461a4655a1d7e33a9bfedd8116a9a5ee553b6",
    "archive_actual_launcher_version": "2.1.29"
  },
  {
    "channel": "itpay-skill-workbuddy",
    "archive": "/Users/tzz/Documents/itpay_cli/candidates/post-v3-audit-2.1.29-final/itpay-skill-workbuddy-2.1.29.zip",
    "sha256": "335e899eb674a20f49f27b96d8f4945af556f741a0f95bad2218d21f8b6a3b9f",
    "archive_actual_launcher_version": "2.1.29"
  }
]
```

## 2026-10-01 发布执行记录（覆盖上面的历史未授权限制）

用户授权发布next。独立仓库操作，#84正常merge为 `a92f140257b69e49814482aea9a3173abd575a07`；本地detached HEAD固定该SHA，原准备分支/候选保留，未改产品源码。

既有CD https://github.com/itpay-ai/cli/actions/runs/36834863675 的工程检查成功，但npm PUT返回E404，未发布。流程结束后改用用户授权的本地发布；网页登录成功，完整npm run check及npm publish原生prepublishOnly检查/packed smoke均成功。首次上传挂起终止；确认版本未发布后，以已有CD相同的ignore-scripts方式复用刚完成检查和相同制品，关闭自动重试，60秒及180秒两次有限上传均FETCH_ERROR超时。未同时运行两条发布路径。

发布打包事实：134文件，SHA-1 `f8312403346a440102b32d833a54b05ddbe62fc0`（与CD打包一致）；原候选SHA-256保持上表，不冒称为已发布包。检查日志 `/tmp/itpay-cli-2.1.29-publish-check.log`；首轮原生publish日志 `/tmp/itpay-cli-2.1.29-publish.log`。最终registry next仍2.1.22、latest仍2.1.1；未完成registry全新@next=2.1.29安装和已发布制品哈希核对。发布阻塞需要恢复本机npm PUT上传连接或修复CD发布权限后择一继续；不再盲重试，不需在聊天发送token/验证码。真实Agent体验未观察。

### 本轮用户再次授权发布后的核对

仍在独立itpay_cli，HEAD `a92f140257b69e49814482aea9a3173abd575a07`；npm whoami成功。直连120秒、显式使用macOS现有HTTP代理120秒、改用本机已有Node22并使用相同代理120秒，均npm PUT FETCH_ERROR超时（关闭自动重试，未改源码/包/永久配置）。最终next=2.1.22、latest=2.1.1；候选SHA-256未变。需要恢复npm上传网络后继续同一版本，未产生已发布包或新安装验证结论。

### 用户要求原始npm publish的本轮执行结果

在独立itpay_cli运行原始 `npm publish --tag next`：prepublishOnly类型/测试/覆盖率/packed smoke及prepack全部通过，134文件SHA-1仍f8312403346a440102b32d833a54b05ddbe62fc0；上传进入慢速传输。后使用已检查相同制品、关闭自动重试、20分钟单次超时以避免短超时重传：Node22现有代理上传从6.8MB增长到16.4MB后EPIPE；Node22直连从4.3MB增长到9.5MB后ECONNRESET/socket hang up。故实际阻塞含上传中途连接断开，不能仅归因于超时。无发布成功响应，无2FA挑战提示；最终registry标签保持next2.1.22/latest2.1.1。需要稳定大请求上传通路后继续同一版本；未更改永久配置、源码或候选文件。

## 发布成功核对（用户完成发布后）

registry next=2.1.29、latest=2.1.1；gitHead=a92f140257b69e49814482aea9a3173abd575a07（registry元数据，tgz内未写gitHead）；registry包SHA-256=db1fa1d6569acb5a54fe3a3bd2ea1ca41b06d582eaf1265311397efc101ee24b，SHA-1与此前发布打包一致。原候选tgz保持，registry下载包单独保存。全新@next安装输出2.1.29，正式Skill、12 Buyer、57编译文件逐字节匹配；134文件无reviews/tests/rollout。证据在独立itpay_cli候选目录NPM-RELEASE-PROOF.json。当前Codex shell全局itpay仍2.1.19，未自动覆盖全局环境；真实宿主体验未观察。此结论覆盖历史发布阻塞记录。
