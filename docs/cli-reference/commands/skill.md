# `itpay skill` / `itpay skill show`

## 范围与意义

读取当前安装包内置的完整 ItPay Agent Skill。Skill 是面向白板 Agent 的精简
入口：帮助其理解用户意图、选择第一条命令并正确读取后续 CLI envelope。
完整参数和状态合同由 `itpay docs` 按 topic 渐进提供，不重复塞入 Skill。

本命令不访问 Backend，不修改宿主配置或本地身份。

```bash
itpay [--agent-type <agent_type>] skill show itpay [--json]
```

当前内置 `itpay`（Services，兼容别名 `itpay-buyer`）与 `itpay-api`（API）。`--json` 时完整 Markdown 位于 `result.content`；文本
模式直接输出完整内容。

## Services：已声明 Agent Type

```json
{
  "status": "shown",
  "result": { "skill": "itpay", "content": "<complete_packaged_SKILL.md>" },
  "instruction": "完整读取 Skill，理解当前用户需求，再选择对应的第一条命令；保持当前 Agent Type。",
  "next": null,
  "recovery": []
}
```

Skill 不能默认把 Agent 引向 Catalog：用户可能要读取以前购买的内容、查看
订单或处理退款。Agent 必须先完成意图判断。当前命令的 `next` 固定为
`null`。

## Services：未声明 Agent Type

未声明时 instruction 要求先选择真实运行环境，`next` 为：

```json
{
  "command": "itpay install --json",
  "reason": "选择真实且稳定的 Agent Type"
}
```

未知 Skill 名称返回 `skill_not_found`；包内文件缺失或损坏返回
`skill_unavailable`。正常读取只返回完整同包 Skill，不附加设备或Backend数据；读取错误仅采用当次允许的同包路径和真实原因，不猜安装目录。

`workbuddy` 只在 instruction 中增加既有的本地权限要求；不改变输入、输出
schema 或意图路由。

## 同包启用

setup 返回当前包的绝对 Skill 路径；完整读取原文，按宿主正式技能安装方式保存启用。同版本已读且启用时无需重复保存；宿主不支持持久发现时记录准确路径与限制，不声称跨会话自动发现已验证。

兼容 `ITPAY_CLI_SKILLS_DIR` 的直接/父目录路径，但其内容必须与当前包原文完全一致。陈旧或改写内容返回非0 `skill_override_mismatch`，给出同包 `result.skill_path` 供直接读取，不宣称已启用。缺包/文档错误只指向原安装方式，不生成会另装全局包的恢复命令。

覆盖路径不可读但原包有效时，返回 `skill_override_unavailable` 和实际读取原因、同包路径；不会把它误报为包损坏或建议另装全局包。

## API 独立读取

`itpay skill show itpay-api --json` 返回 `status:shown`、`result.skill:itpay-api`及完整原文`result.content`；文本模式直接输出原文。无论是否声明Agent Type，`next:null`，不要求先安装Services Skill、setup或设备注册。按需读`itpay api --help`；只有认证实际需要时由本人完成`api connect`，已有任务沿原引用恢复。

API只从当前包`skills/itpay-api/SKILL.md`读取，独立核对生成摘要及frontmatter名称；不读取`ITPAY_CLI_SKILLS_DIR`。该覆盖变量的直接/父目录语义仅供Services，不能替换API指引。API文件缺失/不可读取返回`skill_unavailable`，原文或名称校验失败返回`skill_mismatch`；均停止，不回退Services、下载新说明或写身份。

读取两类Skill均无网络、无登录/身份写操作。未知名称返回`skill_not_found`并明确两合法名，不按相似名称猜测。包内读取通过只证明本地制品完整，不证明npm渠道或真实Agent已验收。

## Entry selection

For a new task, prefer the official pinned ItPay CLI when execution is permitted and available in the current host. Install only through the host-permitted official installation path when authorized. Services tasks use the Services Skill; API tasks use the independent API Skill and `itpay api`. CLI calls HTTP APIs directly, never MCP transport. Without permitted CLI capability, use the corresponding ItPay-hosted user Services MCP or Hub MCP and only its actually available tools; ordinary users do not self-host another MCP. Platform-required workflows and explicit connection tests follow the actual available capability. Entry selection never authorizes a permission bypass: preserve the original identity, entry, request/run and current grant after acceptance or an unknown result. Continue across entries only when the owner explicitly supports recovery under the same actual authority; CLI errors never license a substitute transaction or raw HTTP workaround.
