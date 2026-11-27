# GitHub Actions: manual execution and per-run approval

Effective 2026-10-21 by explicit owner instruction.

面向 main 的 pull_request 仅运行 ci.yml 中的完整测试，固定门禁名为 CLI full PR CI。其余 CI/CD 保留手动触发及现行逐次或明确批次批准；PR 测试授权不包含发布、部署、计划任务或 pull_request_target。完整测试需成功后合并，取消、失败或必要测试跳过均不可代签。
- Before each GitHub Actions run, rerun, deployment, publication or cross-repository batch, explain why it is needed, the exact repository/workflow/ref, affected environment/channel and any downstream runs. Wait for the user's explicit approval of that run or enumerated batch. General coding, testing or past release permission is not approval to consume Actions minutes.
- Record the approval and reason in the run request. Never dispatch or rerun just to obtain a green check. Prefer appropriate local checks and reuse valid evidence. Do not report unrun checks as passed.
- CI approval does not approve CD, npm publication or another repository's workflow. A reusable job inside the explicitly approved run is part of that run; additional dispatches require their own approval or an explicitly enumerated approved batch.
- Do not weaken branch protection or bypass required checks. If a merge needs a check, explain why and request approval for the manual check on the exact candidate.
- Never restore automatic triggers through a merge, generated workflow or sync. GitHub Actions configuration changes do not authorize a workflow run.
