# `itpay readyz`

只检查官方 Backend 存活，不证明设备、登录或业务合同就绪，也不是业务失败后的必跑排障步骤。

```bash
itpay readyz [--json]
```

生产默认 app.itpay.ai，明确测试可选择 sandbox.itpay.ai 或 dev.itpay.ai；不切环境掩盖失败。返回 backend、backend_url、environment；声明 Agent Type 时保留该事实。首次安装或升级后用当前宿主的 setup，之后读取同包Skill。

不可用、网络或兼容问题按当次错误说明处理；有限尝试结束即停止，不循环检测、不登录或下单。minimum_cli_version 是协议门槛，不是已验证推荐包；兼容失败须维护方提供配套制品，不猜版本、不降级、不改身份。文本和JSON相同，不输出凭据。
