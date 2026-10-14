# itpay device

保持当前设备身份和实际Agent Type。正常授权与会话续期由CLI处理；业务错误不能触发身份替换或缓存清理。安装准备见install-and-setup，当前账号登录见identity-and-sessions。

## 当前操作

- status：读取当前设备状态。
- recover：仅运营已确认当前Backend登记库重置，且用户明确授权时，带--confirm-backend-reset处理该Backend缓存。保留设备身份及其他环境状态；不是普通失败恢复动作。
- repair-lock、reset-key：当前不可用，不能作为恢复动作；不改身份。reset-key保留--confirm-key-reset参数识别并返回明确错误。
- --agent-type、--json：使用实际宿主类型和结构化输出。全部参数以当前--help为准；未知结果停止，不删除身份。
