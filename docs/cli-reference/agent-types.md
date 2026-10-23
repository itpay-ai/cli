# Agent Type And Host Contract

Agent Type 表示真实宿主类型；执行位置（本机/云端/unknown）单独判断，host 是展示媒介，target 是该媒介所需的当前可信消息目标。窗口、任务和聊天不是独立身份，不临时换类型或借另一 Backend 的授权。

| Agent Type | 默认 host |
|---|---|
| dot | plain-chat |
| muse | plain-chat |
| codex-desktop | codex |
| codex-cli | terminal |
| claude-code-desktop | claude-code |
| claude-code-cli | terminal |
| workbuddy | plain-chat |
| zcode | plain-chat |
| doubao-work | plain-chat |
| kimi-code | terminal |
| openclaw | 无，必须指定当前可信 host |

commerce 命令使用真实 --agent-type 或 ITPAY_AGENT_TYPE；所有返回命令保留该类型。显式 --host 可覆盖展示但不改变 Agent Type。OpenClaw 的 IM host 还需真实 --target；缺失时使用返回的不可执行模板补可信上下文，不猜目标、不创建替代入口。

当前本地设备密钥与各 Backend 登记相互独立；同 Backend／类型的窗口复用实例。保留身份，正常会话续期由CLI处理，失败不删除密钥、换运行时或另装全局版本。setup 只准备访问状态，不代表已登录、已启用 Skill 或已获购买同意。

## 官方页面展示

所有宿主共享正式 Skill 业务规则；媒介细节只在当前 handoff 与 render-hosts。可用的原生 agent_action 执行一次；工具缺失或失败时同轮展示原始官方URL，不能把普通链接声称成已发按钮或已打开页面。可用链接不等可选二维码完成。桌面展示返回图片／链接；终端必须人确实可见；手机优先直接打开链接，二维码用于另一设备扫码。

WorkBuddy 的 present_files、ZCode 浏览器、OpenClaw message 只在该宿主实际可用时使用，不猜工具、不重复安装。OpenClaw target 是原生chat目标，不自行加 telegram: 前缀。授权 callback 只允许读取同一状态，不能证明付款或授权成功。

付款与已购内容授权是不同事实：付款入口交付后停止，只有服务端核实才称付款成功；内容授权完成后只恢复原 reader，不反复创建 vault access。完整官方URL可向当前用户展示，但不提取、单独记录或重建其中凭据。host不能改变金额、订单、额度、资格、权限或同意范围。

Dot/Muse 保持真实类型，不用 codex-desktop 兼容冒充。受限目录使用 ITPAY_STATE_DIR，后续同一 launcher 保留 Backend/type/state；可写不代表跨会话持久。云浏览器成功打开不证明用户已看见页面，未知显示能力仍为 unknown。

Hermes 使用真实 `hermes`，默认以 plain-chat 如实交付；不冒充其他宿主或承诺未知显示能力。
