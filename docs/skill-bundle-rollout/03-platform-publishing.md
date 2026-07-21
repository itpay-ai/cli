# 各平台制作、验证和上传手册

状态：发布操作手册
规则核对日期：2026-07-21

平台规则会变化。每次正式提交前重新打开本文链接核对，不根据旧截图操作。

## 0. 共用发布前检查

所有平台先满足：

- bundle 绑定精确 `@itpay/cli` 版本和 npm integrity。
- Skill 写明触发条件、外部数据发送、文件/网络/命令权限和人类 Checkout 交接。
- 不包含 `.env`、API key、OAuth client secret、用户 token、Device 私钥或 `~/.itpay-v3`。
- 不在运行时下载 `latest` CLI。
- 云端 Chat 路径使用 MCP OAuth；本地路径使用 Device Authority。
- 不把 OAuth 登录、Skill 启用或 CLI Device 注册视为付款授权。
- 支付卡、CVV、支付密码、验证码和钱包私钥不进入聊天、Skill 或 CLI 参数。
- 准备网站、支持、隐私政策、服务条款、退款说明和公开联系方式。
- 准备允许和禁止场景测试；禁止场景必须停止或转交人类。

## 1. OpenAI：ChatGPT + Codex

### 选择的产品形态

提交 **app-plus-skills plugin**，而不是 skills-only：

```text
ItPay MCP App    用户 OAuth、服务端身份、账号范围工具
ItPay Skill      工作流、触发、安全边界、本地 Codex bundle
```

一次批准发布后进入 ChatGPT 与 Codex 共用的 Plugins Directory。ChatGPT 云端调用 MCP；本地 Codex 只有在 shell/runtime 可用时使用 bundle。

### 准备材料

- OpenAI Platform 中已验证的个人或企业发布身份。
- 提交者具备 Apps Management Write 权限。
- 公开 production MCP URL。
- MCP 域名控制权和 `/.well-known/openai-apps-challenge` challenge 响应能力。
- OAuth 配置及无需 MFA、短信、邮件确认或内网的审核账号。
- 每个工具准确的 `readOnlyHint`、`openWorldHint`、`destructiveHint`。
- 精确 CSP 允许域名。
- Skill bundle/ZIP，包含最终 `SKILL.md`、脚本、CLI bundle 和资源。
- 5 个正向测试、3 个负向测试。
- starter prompts、国家/地区、release notes。
- website、support、privacy、terms 和品牌 Logo。

### 制作与测试

1. 生成 OpenAI repo 的精确 CLI bundle。
2. Skill 中规定：有 ItPay MCP tool 时优先 MCP；不得为了寻找本地认证而读取任意 HOME 路径。
3. MCP 工具返回不含 token、内部用户 ID、Device ID、debug payload 或未披露个人数据。
4. 对创建 Checkout、退款等工具设置真实写操作 annotation 和平台确认。
5. 使用最终文件树在 ChatGPT 和 Codex 分别测试，不用开发目录外文件。

### 上传

1. 打开 [OpenAI Plugin submission portal](https://platform.openai.com/plugins)。
2. 选择 `Create plugin` -> `With MCP`。
3. 填写 Info 和已验证 Developer Identity。
4. 填 production MCP URL、认证、CSP，完成域名 challenge 并扫描工具。
5. 上传最终 Skill bundle。
6. 填 starter prompts。
7. 提交恰好 5 个正向、3 个负向测试。
8. 选择实际可运营的国家/地区并填 release notes。
9. 完成 policy attestations 后 Submit for Review。
10. 审核通过后由发布者在 portal 手动 Publish。

### ItPay 特有审核点

- MCP/Skill 只创建并展示外部 Checkout handoff；最终支付由用户在 ItPay/支付提供方页面确认。
- 清楚展示商户、商品、币种、总额、ItPay 费用和退款条件。
- 公共 Skill 不把 `pay` 或 `buy --pay` 描述成正常恢复路径。
- 测试账号使用测试商户和限额，不要求审核人员真实付款。

### 官方依据

- [Submit plugins](https://learn.chatgpt.com/docs/submit-plugins)
- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256)
- [OpenAI App Developer Terms](https://openai.com/policies/developer-apps-terms/)
- [OpenAI Commerce Policies](https://openai.com/policies/commerce-policies/)

## 2. Claude Code

### 产品形态

使用 Claude Plugin：

```text
.claude-plugin/marketplace.json
plugins/itpay/.claude-plugin/plugin.json
plugins/itpay/skills/itpay/SKILL.md
plugins/itpay/bin/itpay
plugins/itpay/vendor/itpay-cli/
plugins/itpay/.mcp.json（远程 MCP 上线时）
```

Claude Code 会将 plugin root 的 `bin/` 加入 Bash PATH，并把市场插件复制到 `~/.claude/plugins/cache`。插件不得引用目录外文件；持久数据应使用 `${CLAUDE_PLUGIN_DATA}`，但 ItPay Device Authority 仍使用用户 HOME 下的 `~/.itpay-v3`，不要写 plugin cache。

### 制作与测试

1. `plugins/itpay/bin/itpay` 调用 plugin 内 vendored CLI，不调用全局 CLI。
2. `plugins/itpay/skills/itpay/SKILL.md` 只引用 plugin 内路径或 PATH 中这个启动器。
3. MCP 配置中的内部路径使用 `${CLAUDE_PLUGIN_ROOT}`。
4. 执行：

```bash
claude plugin validate .
claude --plugin-dir .
```

5. 在同时安装全局旧版 `itpay` 的机器上确认 Skill 使用 bundle 版本。
6. 更新 plugin 后运行 `/reload-plugins` 或重启会话验证新版本。

### 独立分发

可以先用同一个 Claude 平台仓库中的 marketplace：

```text
itpay-skill-claude-code/
  .claude-plugin/marketplace.json
  plugins/itpay/
```

用户执行：

```bash
/plugin marketplace add itpay-ai/<marketplace-repo>
/plugin install itpay@<marketplace-name>
```

marketplace entry 使用相对 source `./plugins/itpay`。版本字段变化后用户才会收到对应更新；不要长期指向浮动未验证分支。

### 提交官方市场

1. 完成 README、版本策略、manifest、验证和测试。
2. 打开以下任一官方表单：
   - `https://claude.ai/settings/plugins/submit`
   - `https://platform.claude.com/plugins/submit`
3. 提交 plugin 仓库、功能、权限、数据外发、MCP 和支持信息。
4. 根据审核反馈更新独立仓库并重新验证。

Claude 官方文档没有承诺所有提交都会收录，也没有提供 Skill 原生收费通道。ItPay 收费仍通过 ItPay 账号和外部 Checkout。

### 官方依据

- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Discover plugins and official submission](https://code.claude.com/docs/en/discover-plugins)
- [Create and distribute a marketplace](https://code.claude.com/docs/en/plugin-marketplaces)

## 3. Gemini CLI

### 产品形态

使用独立 Gemini Extension 仓库：

```text
gemini-extension.json
skills/itpay/SKILL.md
bin/itpay
vendor/itpay-cli/
```

`gemini-extension.json` 必须位于仓库或 release archive 的绝对根目录。manifest `name` 使用小写和连字符，`version` 与 GitHub Release tag 保持一致。

### 制作

最小 manifest 由平台仓库实施时按当时 schema 生成，核心字段：

```json
{
  "name": "itpay",
  "version": "2.0.14",
  "description": "Use ItPay services through a bundled CLI and authenticated MCP workflows"
}
```

Skill 放在 `skills/itpay/SKILL.md`。路径必须使用 `${extensionPath}`。若加入 MCP，在 `mcpServers` 中使用明确的 `command`/`args` 或平台支持的远程配置；用户 workspace 配置优先于 extension 同名 MCP，因此测试冲突行为。

不要把 ItPay 用户 token设计成普通 extension setting。Gemini 会过滤未声明的环境变量，敏感 setting 也不能替代标准 OAuth。MCP 用户认证仍走任务一的 OAuth 系统。

### 本地验证

```bash
gemini extensions link .
```

重启 Gemini CLI，确认：

- `/extensions list` 显示 ItPay；
- Skill 被发现；
- bundle 版本正确；
- 无全局 CLI 时仍可运行；
- extension 更新后重新启动才加载新组件。

### 公开和自动收录

1. 将仓库设为 public GitHub repo。
2. 在 GitHub About 添加 topic：`gemini-cli-extension`。
3. 确保根目录存在 `gemini-extension.json`。
4. 创建与 manifest version 一致的 tag 和 GitHub Release。
5. 若 release 使用 archive，确保 archive 自包含且 manifest 仍在根目录。
6. Gemini crawler 每日扫描带 topic 的 tagged repositories；验证通过后自动进入 Extension Gallery，不需要提交 issue 或邮件。

用户也可直接安装：

```bash
gemini extensions install https://github.com/itpay-ai/<repo>
```

### 官方依据

- [Extension reference](https://geminicli.com/docs/extensions/reference/)
- [Build extensions](https://geminicli.com/docs/extensions/writing-extensions/)
- [Release extensions and Gallery indexing](https://geminicli.com/docs/extensions/releasing/)

## 4. WorkBuddy

### 已确认能力

WorkBuddy 官方文档确认：

- Skill 可以封装可执行脚本和工作流。
- 用户可以在技能页面上传本地技能包。
- 安装时会进行安全扫描。
- 第三方 Skill 可能读取本地文件、运行系统命令并把数据发送给第三方；需要清楚披露。
- Skill 的系统命令以用户本人身份执行；资金类操作应先小范围验证。
- WorkBuddy 已支持 MCP 标准 OAuth，更新日志也记录了“支持带登录态调用 Skill”。

### 制作与本地上传

1. 生成 `itpay-skill-workbuddy` 的自包含 Node bundle。
2. `SKILL.md` frontmatter 提供清晰名称、描述和触发条件。
3. 声明：执行本地命令、连接 `app.itpay.ai`、写入 owner-only `~/.itpay-v3` Device 状态、显示外部 Checkout。
4. 不申请屏幕控制、任意目录写入或与 ItPay 无关的网络权限。
5. 将 Skill 根目录打成 WorkBuddy 可接受的本地技能包。
6. 在 WorkBuddy：技能 -> 添加技能 -> 上传技能，选择技能包。
7. 检查安全扫描结果和权限提示，分别在默认权限、完全访问权限下验证；默认权限必须能够通过用户确认完成流程。
8. 验证 macOS 和 Windows，尤其是 Node 可用性、中文用户名、路径空格、持久 HOME 和版本更新。

### SkillHub 公共发布

截至核对日期，公开文档说明了 SkillHub 浏览、搜索、一键安装和本地技能包上传，但没有公开社区开发者提交入口、manifest schema 或审核表单。

因此当前操作是：

1. 先完成独立公开仓库、可下载技能包、本地上传和安全扫描。
2. 通过 WorkBuddy/腾讯官方支持渠道申请 SkillHub 发布资格和最新提交规范。
3. 取得官方 schema 后只在 WorkBuddy 仓库增加必要 manifest，不改变 CLI 主仓库。
4. 按资金类 Skill 要求提供测试账号、外部 Checkout、权限和客服说明。

在官方确认前，不对外宣称“已进入 SkillHub”或“添加 GitHub topic 即会自动收录”。

### 官方依据

- [WorkBuddy 技能与本地技能包上传](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy 更新日志：SkillHub、安全扫描、MCP OAuth](https://www.workbuddy.cn/docs/workbuddy/Changelog)
- [WorkBuddy 权限模式](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)

## 5. 发布矩阵

每次发布维护下面的实际状态，不用“CLI 已发布”推断所有平台已更新：

| CLI | OpenAI | Claude official | Claude own marketplace | Gemini Gallery | WorkBuddy local package | WorkBuddy SkillHub |
| --- | --- | --- | --- | --- | --- | --- |
| `X.Y.Z` | draft/review/published | draft/review/published | tag | indexed | artifact | pending/review/published |

每个平台的用户实际拿到哪个版本，由其商店审核、tag 和更新机制决定。Backend compatibility 必须继续返回精确最低 CLI 版本，不能要求用户盲目安装 `latest`。
