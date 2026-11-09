# 当前 CLI 开发交付

开发安装/升级唯一入口：[dev.itpay.ai/agent](https://dev.itpay.ai/agent)，脚本 `/agent/install.sh`。唯一当前候选 `account-connection-review-20261109`，基础版本2.1.67，是 main 构建的独立 dev 包，不等同 npm 渠道。

最终待合并 revision 取得明确 Codex 审查结论、处理意见后正常合并。从该 main 运行 npm ci/build/pack；公开包、两 Skill、Buyer 文档与实际编译内容一起交付。V4 按 [当前部署流程](https://github.com/itpay-ai/compose-v4/blob/main/docs/DEPLOYMENT.md) stage guide/installer/当前 tgz、备份并选择性激活。更新同名候选须更新交付修订，installer 同时核候选/修订并绕开缓存，不能因2.1.67或候选同名而跳过。

全新安装用公开脚本 `--install-only`，随后在该 prefix 读两份 Skill 和命令帮助。已有安装仅在已确认原 prefix/原 launcher 使用 `--upgrade-only --launcher`；不动账号/profile/设备密钥/原任务，不以升级触发登录。新任务用 agent 保存原句、统一确认页与原地等待；setup 给出的首次连接动作、auth login、api connect 同样进入已实现的统一确认。已有请求按原动作恢复，MCP 由宿主完成各自正常 OAuth。

充值原句：可以打开钱包充值，也可以告诉我金额，我直接给你扫码付款。
用户报金额直接用 wallet --topup 金额，原请求用 --request 保留；快捷项不限制金额，最低金额由现行服务端合同确定。链接/码同时标当前账号名字·末6位，官方同单码与收银台不重建。

公开验收从 /agent 全新隔离安装，读实包 Skill/help/输出例并核 dev MCP，只读、不代 Owner 宿主测试。本批唯一结果：`~/.codex/artifacts/account-connection-review-20261109/RESULT.json`。正式 npm 发布规则仍在 [RELEASE](RELEASE.md)，不由 dev 交付授权。
