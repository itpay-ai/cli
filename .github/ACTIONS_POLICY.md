# GitHub Actions: manual execution and per-run approval

Effective 2026-10-21 by explicit owner instruction.

- Commits, pull requests, releases, schedules and completion of another workflow must not automatically start CI/CD. Entry workflows use only `workflow_dispatch`. Reusable `workflow_call` workflows may run only as part of a user-approved manual entry.
- Before each GitHub Actions run, rerun, deployment, publication or cross-repository batch, explain why it is needed, the exact repository/workflow/ref, affected environment/channel and any downstream runs. Wait for the user's explicit approval of that run or enumerated batch. General coding, testing or past release permission is not approval to consume Actions minutes.
- Record the approval and reason in the run request. Never dispatch or rerun just to obtain a green check. Prefer appropriate local checks and reuse valid evidence. Do not report unrun checks as passed.
- CI approval does not approve CD, npm publication or another repository's workflow. A reusable job inside the explicitly approved run is part of that run; additional dispatches require their own approval or an explicitly enumerated approved batch.
- Do not weaken branch protection or bypass required checks. If a merge needs a check, explain why and request approval for the manual check on the exact candidate.
- Never restore automatic triggers through a merge, generated workflow or sync. GitHub Actions configuration changes do not authorize a workflow run.
