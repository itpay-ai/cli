# ItPay CLI

Services与API两个入口；安装与正式Skill见现有setup及发布导航。

```mermaid
flowchart TD
 A01[安装 / 固定profile与包版本] --> A02[Device链接 / 每轮等120秒]
 A02 --> A03[同页确认连接和预填单次额度 / 可切仅免费]
 A03 --> AS[原 verifier 对应的 AS done 302 / 网关落盘]
 AS --> HC[Backend worker提交原receipt / V4激活代次]
 A04 -->|连接已保存，新任务| B01[网站同一可售货架 / CLI和原MCP discover]
 B01 --> B02[show：用途、价格、ISO示例、TTL并缓存]
 B02 --> B03[用户同意后call / 自动原ID和展示价]
 B03 -->|连接失效| A05[锁内refresh / 必要时Device续原consumer]
 A05 --> A03
 HC -.全入口验证后才可异步清理旧 AS 授权.-> O01
 A03 --> PENDING[未就绪 / 按原handle继续等]
 HC -->|ready| A04[status ready / Device兑换 / 新鲜 me / 原子保存]
 PENDING -.只读status.-> HC
 PENDING -->|明确失效或过期| A02
 PENDING -->|拒绝或取消| STOP[结束原 flow / 停止兑换]
 A04 -->|已有原请求| B04[先读原单 / 有run只读、未派发才接续]
 B04 --> R[结果与收据 / status只读]
 B03 -->|免费或付费成功| R
 B03 -->|余额不足| T[原单官方充值 / 隔离仅fakepass]
 T -->|有原intent| W[到账worker或call内部继续原单]
 W --> B04
 B03 -->|准入前变价且0扣0冻结| N[原单结束 / show新价再获同意]
 N --> B02
 B03 -->|结果未知| U[status原单 / 账务待核对]
 B03 -->|确定失败且0扣0冻结| F[本次没扣钱]
 R --> V[wallet余额和主动充值链接]
 V -->|主动充值| T
 T -->|无原intent只更新余额| V
 A02 -.脱敏事件.-> O01[原events和outbox / admin trace与漏斗]
 B03 -.原request事件.-> O01
 R -.费用与交付事实.-> O01
 O01 -.只读事实.-> O02[原60秒worker / 三异常WARN]
 O03[原worker和AS cron / 到期清正文] -.保留费用和未决引用.-> O01
```

目标未实施：授权先做、货架后做，新增身份续接/同页同意合同待图复审；现有固定安装包保持现状。

[开发合同](docs/DEVELOPMENT.md#api-journey-contract) · [架构](docs/ARCHITECTURE.md) · [测试与证据](docs/TESTING.md#api-journey-evidence) · [维护入口](AGENTS.md) · [部署与发布](docs/RELEASE.md) · [合同](docs/CONTRACTS.md) · [待办](docs/BACKLOG.md)
