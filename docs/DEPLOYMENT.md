# 当前 CLI 开发交付

开发安装/升级唯一入口：[dev.itpay.ai/agent](https://dev.itpay.ai/agent)，脚本 `/agent/install.sh`；也可在获准的独立 prefix 安装 `npm i @itpay/cli@next`。当前开发版为正式发布的2.1.68，公开脚本固定安装这一版本，不再从独立候选包供货。next更新按当前明确批准；latest及其他渠道不由dev更新授权。

最终待合并 revision 取得明确 Codex 审查结论、处理意见后正常合并，再沿 [RELEASE](RELEASE.md) 的受检制品/OIDC流程发布。V4 按 [当前部署流程](https://github.com/itpay-ai/compose-v4/blob/main/docs/DEPLOYMENT.md) 更新guide/installer与正式npm回退入口，不重建Backend/Hub。安装后从原launcher读取实际版本、两Skill与help；不要只根据版本文件宣称已交付。

全新安装用公开脚本 `--install-only`，随后在该 prefix 读两份 Skill 和命令帮助。已有安装仅在已确认原 prefix/原 launcher 使用 `--upgrade-only --launcher`；不动账号/profile/设备密钥/原任务，不以升级触发登录。新任务用 agent 保存原句、统一确认页与原地等待；setup 给出的首次连接动作、auth login、api connect 同样进入已实现的统一确认。已有请求按原动作恢复，MCP 由宿主完成各自正常 OAuth。

充值原句：可以打开钱包充值，也可以告诉我金额，我直接给你扫码付款。
用户报金额直接用 wallet --topup 金额，原请求用 --request 保留；快捷项不限制金额，最低金额由现行服务端合同确定。链接/码同时标当前账号名字·末6位，官方同单码与收银台不重建。

公开验收从 /agent 全新隔离安装，读实包 Skill/help/输出例并核 dev MCP，只读、不代 Owner 宿主测试。本批唯一结果：`~/.codex/artifacts/account-connection-review-20261109/RESULT.json`。正式 npm 发布规则仍在 [RELEASE](RELEASE.md)，不由 dev 交付授权。
