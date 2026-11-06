# ItPay CLI

Services与API两个入口；安装与正式Skill见现有setup及发布导航。

```mermaid
flowchart TD
 A[安装与固定版本核对] --> B[本Agent独立连接]
 B --> C[网站分类 / categories和list]
 C --> S[show：用途、价格、真实示例、TTL]
 S --> Y[Agent告知用户并取得同意]
 Y --> Q[call：自动原请求ID和已展示价格]
 Q -->|免费或付费成功| R[结果与收据 / status只读取回]
 Q -->|余额不足| T[原单官方充值]
 T --> W[到账worker或call内部续原单]
 W --> R
 Q -->|准入前变价且确认零扣费| N[原单结束 / 展示新价]
 N --> S
 Q -->|确定失败且零扣费| F[本次没扣钱]
 Q -->|派发未知或已扣费| U[status只读原单和费用]
 R --> Z[wallet余额 / owner网页记录]
```

目标未实施：授权先做、货架后做，待Charlie确认；现有固定安装包保持现状。

[开发合同](docs/DEVELOPMENT.md#api-journey-contract) · [架构](docs/ARCHITECTURE.md) · [测试与证据](docs/TESTING.md#api-journey-evidence) · [维护入口](AGENTS.md) · [部署与发布](docs/RELEASE.md) · [合同](docs/CONTRACTS.md) · [待办](docs/BACKLOG.md)
