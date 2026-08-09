# Bundle 同步运维与事故处理

## 正常状态

每次同步必须在 Job Summary 中给出 published version、automation branch、同步决策、凭据模式、PR URL 和关闭的 superseded PR 数量。

同步决策只有以下正常结果：

- `base-current`：main 已经包含目标版本，无需更新。
- `pr-current`：当前版本的 open PR 已包含正确 bundle，不得产生新 commit。
- `update-required`：目标版本不存在，需要构建并创建 PR。
- `open-pr-artifact-missing`：PR 分支缺少 lock，需要重新构建。
- `open-pr-artifact-mismatch`：PR 中的 version、format 或 bundle directory 不符合 caller 合同，需要重新构建。

## 失败分类

### GitHub Actions 启动故障

以下证据表示仓库代码没有运行：

- run 的 `steps` 为空；
- 失败发生在 `Set up job`；
- `Failed to resolve action download info`；
- Hosted Runner 长时间 queued 后被 cancelled 或 timed out。

先查看 GitHub Status。官方确认恢复后重跑原 SHA；不得为了这种故障修改 bundle、测试或业务代码。

### Bundle 构建或测试故障

以下步骤失败才属于仓库或产物问题：

- Resolve published version
- Rebuild bundle
- Inspect upstream Skill changes
- Verify platform bundle

保留失败分支和日志，不创建或更新 PR，不跳过 `npm test`。

### `action_required`

由 `GITHUB_TOKEN` 创建或更新的 PR workflow 会进入 approval-required 状态。这不是测试失败，但测试尚未执行。仓库写权限用户可以批准该 run；要求零人工同步时，必须配置最小权限 GitHub App，禁止使用个人 PAT。

## 重跑规则

1. 只重跑仍指向当前 head SHA 的基础设施失败。
2. 新 commit 已存在时不重跑旧 SHA。
3. 同一个版本第二次同步必须保持 automation PR head SHA 不变。
4. 不把 cancelled、action-required 或旧 SHA 的 success 当作当前版本通过。

## Superseded PR

新版本 PR 建立并通过平台 `npm test` 后，可以关闭旧机器人同步 PR。自动关闭只允许处理带同步标记、分支符合 `automation/itpay-cli-X.Y.Z`、且所有提交均由 `itpay-bundle-bot` 产生的 PR。检测到人工提交时必须保留并在 summary 中提示。关闭时保留远程分支，不自动删除历史。

## GitHub App 权限

`itpay-bundle-sync` 只安装到分发仓库，权限限定为：

- Metadata: read
- Contents: read/write
- Pull requests: read/write

App 不需要 Actions、Secrets、Administration、Deployments 或 Packages 写权限。私钥只存于组织 Actions secrets，通过 reusable workflow 生成当前仓库、当前 job 有效的短期 token。
