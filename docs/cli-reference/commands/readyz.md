# `itpay readyz`

只检查官方 Backend 存活，不证明设备、登录或业务合同就绪，也不是业务失败后的必跑排障步骤。

```bash
itpay readyz [--json]
```

生产默认 app.itpay.ai，明确测试可选择 sandbox.itpay.ai 或 dev.itpay.ai；不切环境掩盖失败。返回 backend、backend_url、environment；声明 Agent Type 时保留该事实。首次安装或升级后用当前宿主的 setup，之后读取同包Skill。

不可用、网络或兼容问题按当次错误说明处理；有限尝试结束即停止，不循环检测、不登录或下单。minimum_cli 和精确 blocked_versions 决定是否需升级，recommended_cli 只提示；缺能力仅影响对应新操作，hash/revision 只诊断。保留原安装位置、身份与请求。文本和JSON相同，不输出凭据。
