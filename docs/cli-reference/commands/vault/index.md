# `itpay vault`

帮助当前 Local Agent 查找并读取同一 ItPay 账号以前购买并保存的内容。
面向用户时使用“已购内容”“以前的报告”或具体服务名称；`Vault`、
`artifact_ref`、Device 和 grant 只属于内部命令合同。

```bash
itpay vault list [--query <text>] [--host <host>] [--target <target>]
itpay vault access [--artifact <artifact_ref>] [--host <host>] [--target <target>]
itpay vault read --artifact <artifact_ref> [--section <name>...] [--host <host>] [--target <target>]
```

第一次使用或授权过期时，读取命令返回唯一的 `vault access` 下一步。用户在
ItPay 页面登录并选择授权时长；Agent 不选择账号或时长。授权完成后，Agent
重新运行最初的 list、orders 或 read 命令，不重复创建授权请求。

这些命令不创建购买、支付、退款或 Provider 调用，不接收 Buyer、OAuth、
MCP 或浏览器 Session token。
