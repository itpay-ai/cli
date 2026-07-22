# 核心任务二：多平台 Bundle Skill 仓库与自动同步

状态：首批平台已实施

## 1. Current State

当前 CLI 主仓库：

- npm 包名为 `@itpay/cli`，当前版本由 `package.json` 管理。
- `npm run check` 执行类型检查、测试覆盖率和打包 smoke test。
- main 分支 CD 在验证后发布精确 npm 版本。
- npm 包已经包含 `bin/`、`dist/src/`、`docs/`、`skills/`、README 和 LICENSE。
- CLI 运行依赖 Node.js 18+，并依赖 `commander`、`qrcode`。
- `skills/itpay/SKILL.md` 是当前通用 Skill 合同，但没有四个平台各自的 manifest、目录结构和商店发布材料。

只复制 npm 包 tarball 并不等于自包含 bundle，因为 npm tarball 不包含生产 `node_modules`。真正的 bundle 必须在发布时装入精确生产依赖，或者未来另行构建单文件/原生可执行文件。

## 2. Target Behavior

建立四个独立平台仓库。每个仓库只维护：

```text
平台 manifest 和适配说明
平台专用 SKILL.md
由自动化生成的 vendor/itpay-cli bundle
bundle.lock.json
平台测试与发布材料
```

CLI 发布后：

```text
@itpay/cli@X.Y.Z 发布成功
  -> 各平台仓库定时读取 npm dist-tags.latest
  -> 下载精确 X.Y.Z 和 npm integrity
  -> 安装精确 production dependencies
  -> 生成 bundle 和 lock
  -> 运行无全局 CLI smoke test
  -> 创建同步 PR
  -> 人工审查平台差异
  -> 合并、打 tag、按平台上传/发布
```

## 3. Scope

### In scope

- 四个独立仓库和平台 manifest。
- 通用 CLI bundle 生成脚本。
- npm 版本、integrity、源 commit 的锁定记录。
- CLI 发布后的跨仓同步 PR。
- 无全局 CLI、无运行时 npm 下载的测试。
- macOS、Linux、Windows 平台适配验证。
- 平台审核包、release notes 和回滚规则。

### Out of scope

- 把 CLI 源码复制到四个仓库继续开发。
- 每个平台 fork 一套业务逻辑。
- 运行时自动执行 `npm install -g @itpay/cli@latest`。
- 在 CLI 发布时绕过平台审核自动公开商店版本。
- 第一阶段引入新的单文件打包器或原生二进制工具链。

## 4. 仓库布局

### OpenAI

```text
itpay-skill-openai/
  plugin metadata / submission assets
  skills/itpay/SKILL.md
  skills/itpay/scripts/itpay
  skills/itpay/vendor/itpay-cli/
  bundle.lock.json
  tests/
  submission/
```

ChatGPT 云端工作流优先调用远程 MCP；本地 Codex 在平台允许 shell 且 bundle 可执行时才能使用 bundled CLI。Skill 必须明确这个选择，不能在 ChatGPT 沙箱里把 `~/.itpay-v3` 当长期用户认证。

### Claude Code

```text
itpay-skill-claude-code/
  .claude-plugin/marketplace.json
  plugins/itpay/
    .claude-plugin/plugin.json
    skills/itpay/SKILL.md
    bin/itpay
    vendor/itpay-cli/
    .mcp.json               # 远程 MCP 上线时加入
  bundle.lock.json
  README.md
```

一个 Claude 平台仓库同时承载 marketplace catalog 和 ItPay plugin，不另建第五个仓库。Claude Code 会把 plugin root 的 `bin/` 加入 Bash PATH。`bin/itpay` 只负责定位本仓库内 vendor 入口，不搜索或调用全局 `itpay`。

### Gemini CLI

```text
itpay-skill-gemini-cli/
  gemini-extension.json
  skills/itpay/SKILL.md
  bin/itpay
  vendor/itpay-cli/
  bundle.lock.json
  README.md
```

manifest 位于绝对根目录。Skill 命令使用 `${extensionPath}` 定位 bundle，不依赖安装目录名称。

### WorkBuddy

```text
itpay-skill-workbuddy/
  SKILL.md
  scripts/itpay
  vendor/itpay-cli/
  bundle.lock.json
  README.md
```

最终压缩结构以 WorkBuddy 实际上传校验结果为准。当前官方文档确认可以上传本地技能包，但未公开社区 SkillHub 提交 schema，因此不要预先创造私有 manifest。

## 5. Bundle 合同

### 第一阶段产物

第一阶段使用“vendored Node bundle”，不增加打包器：

```text
vendor/itpay-cli/package/       npm 包内容
vendor/itpay-cli/node_modules/  仅 production dependencies
bin/itpay                       平台薄启动器
bundle.lock.json                来源证明
```

运行时不得联网安装。宿主必须已有 Node.js 18+。如果某平台审核环境没有 Node，再单独启动“standalone executable”任务；不要在还没有失败证据时提前维护多架构二进制。

### `bundle.lock.json`

至少包含：

```json
{
  "schemaVersion": 1,
  "package": "@itpay/cli",
  "version": "2.0.14",
  "npmIntegrity": "sha512-...",
  "sourceGitSha": "...",
  "generatedAt": "2026-07-21T00:00:00Z",
  "node": ">=18"
}
```

不要把 token、registry credential、构建机路径或本地身份写入 lock。

### 启动器规则

- 只调用 bundle 内的 CLI 入口。
- 正确转发全部参数、stdout、stderr 和 exit code。
- 不修改 `HOME`，使本地平台继续复用真实 `~/.itpay-v3`。
- 不回退到 PATH 中的另一个 `itpay`，避免同机双版本不确定性。
- `itpay --version` 必须等于 `bundle.lock.json.version`。

用户全局安装的 CLI 可以同时存在：终端里执行全局 `itpay` 使用全局版本；Skill 内必须调用平台 bundle 的绝对路径或 plugin PATH 中的启动器。两者共享同一 `~/.itpay-v3` Device schema，因此共享本地 Device 身份，但代码版本由调用路径明确决定。

## 6. Implementation Steps

### Step 1：建立 bundle 生成器

位置：优先放在 CLI 主仓库 `scripts/`，四个仓库调用同一已发布脚本或复制极小且固定的生成逻辑。

- 输入必须是精确 semver，拒绝 `latest`、范围和未发布版本。
- 从 npm registry 读取版本、dist.integrity 和 gitHead。
- 下载 tarball并验证 integrity。
- 安装 `--omit=dev --ignore-scripts` 的精确生产依赖。
- 删除 npm cache、测试临时文件和不需要的元数据。
- 生成 `bundle.lock.json`。

依赖：现有 npm 发布成功。

### Step 2：建立四个平台仓库

- 每个仓库只保留一个平台的 manifest、Skill、bundle、测试和发布说明。
- 平台专用 Skill 从当前 `skills/itpay/SKILL.md` 派生，但认证、路径和工具选择规则允许平台差异。
- 通用业务规则不得四处手工修改；同步器每次更新时生成或校验通用段落。
- 支付相关公共 Skill 默认只引导外部 Checkout；operator escape hatch 不作为推荐工作流。

依赖：Step 1。

### Step 3：加入仓库内验证

每个平台至少验证：

```text
没有全局 itpay 命令
不允许测试过程访问 npm registry
bundle itpay --version == lock.version
bundle itpay skill show itpay --json 成功
平台 manifest 可被官方 validator/CLI 读取
启动器路径含空格时仍可运行
bundle 不包含凭据、.env、~/.itpay-v3 或 npm token
```

本地身份与网络业务测试使用临时 HOME；不得触碰开发者真实 `~/.itpay-v3`。

依赖：Step 2。

### Step 4：CLI 发布后创建同步 PR

CLI 主仓库在 `main` 提供 reusable workflow。各平台仓库每小时错峰运行 caller workflow，并可手动触发；只有 npm `dist-tags.latest` 高于当前 `bundle.lock.json.version` 时才更新。平台仓库自身的 `GITHUB_TOKEN` 写入本仓库，因此不需要跨仓 PAT，也不会在 CLI 发布失败时提前同步未发布版本。

检测到新版本后：

- 重新生成 bundle；
- 更新 manifest 版本、lock、changelog；
- 跑全套测试；
- 创建或刷新 `automation/itpay-cli-X.Y.Z` 分支和同步 PR；
- PR 描述列出 CLI commit、integrity、平台测试和是否需要商店重新审核。

同步 workflow 只开 PR，不合并、不打 tag、不发布平台商店版本。

依赖：Step 3。

### Step 5：平台发布和回滚

- 合并同步 PR 后为平台仓库打与 manifest 一致的 tag。
- OpenAI、Claude 官方市场和 WorkBuddy 按各自审核流程上传；Gemini GitHub Release 可由 tag 自动生成。
- 保存每个平台已发布 CLI 版本矩阵。
- 回滚通过重新发布上一个已验证 bundle 对应的平台版本，不修改或删除用户 Device 身份。

依赖：Step 4。

## 7. API / Data / Type Changes

CLI 业务 API：无。

新增发布合同：

- `bundle.lock.json` schema。
- CLI reusable workflow 与各平台 caller workflow。
- 每个平台 manifest 和平台版本。

CLI 版本和平台包版本第一阶段保持相同，减少映射成本。若以后平台仅修改说明而 CLI 未变，再引入独立的 `pluginVersion`，同时保留 `cliVersion`；现在不提前增加双版本系统。

## 8. Tests / Verification

### 自动化

- bundle integrity、精确版本和依赖完整性。
- 无全局 CLI、离线 smoke、路径含空格、Windows 启动。
- Skill frontmatter/manifest 校验。
- secret scan 和危险文件清单。
- 发布矩阵与 npm 当前版本漂移检测。

### 手动

- 四个平台全新安装。
- 同机存在全局旧版 CLI 时，Skill 仍调用 bundle 版本。
- Skill 更新后 bundle 版本更新，但 `~/.itpay-v3/device` 未变化。
- 平台卸载 Skill 后不删除用户已有 CLI Device 身份；是否保留平台专用缓存按平台规则处理。

## 9. Risks / Uncertainties

- OpenAI Skill 沙箱是否提供满足要求的 Node 运行时不能作为稳定合同；ChatGPT 路径应以远程 MCP 为主。
- vendored `node_modules` 会增大包体，但当前依赖很少，先以真实平台大小限制验证，不提前引入 bundler。
- 四个仓库意味着四套审核节奏，但不意味着四套 CLI 业务实现。
- WorkBuddy 公共 SkillHub 提交通道未公开，自动化只能先生成可上传包。
- 平台安全扫描可能拒绝支付或可执行 bundle；拒绝原因应反馈到相应平台仓库，不改变其他平台已通过版本。

## 10. Checkpoint

首批仓库、生成器和无跨仓凭据的同步 workflow 已完成。剩余 checkpoint 是各平台审核与人工发布；这些步骤不由同步 workflow 自动执行。
