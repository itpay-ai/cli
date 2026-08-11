# `itpay skill` / `itpay skill show`

## 范围与意义

读取 npm 包内置的完整 ItPay Agent Skill。Skill 是面向白板 Agent 的精简
入口：帮助其理解用户意图、选择第一条命令并正确读取后续 CLI envelope。
完整参数和状态合同由 `itpay docs` 按 topic 渐进提供，不重复塞入 Skill。

本命令不访问 Backend，不修改宿主配置或本地身份。

```bash
itpay [--agent-type <agent_type>] skill show itpay [--json]
```

当前只内置 `itpay`。`--json` 时完整 Markdown 位于 `result.content`；文本
模式直接输出完整内容。

## 已声明 Agent Type

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

## 未声明 Agent Type

未声明时 instruction 要求先选择真实运行环境，`next` 为：

```json
{
  "command": "itpay install --json",
  "reason": "选择真实且稳定的 Agent Type"
}
```

未知 Skill 名称返回 `skill_not_found`；包内文件缺失或损坏返回
`skill_unavailable`。除完整已发布 Skill 内容外，不得附加本地路径、安装
目录、环境变量、Device 状态或 Backend 数据。

`workbuddy` 只在 instruction 中增加既有的本地权限要求；不改变输入、输出
schema 或意图路由。
