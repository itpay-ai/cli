## GitHub Actions cost policy (2026-10-21)

All GitHub Actions CI/CD is manual and requires the user's approval for each run or explicitly listed batch. Before dispatching or rerunning, explain the reason, repository/workflow/ref and downstream costs. Past coding/deployment authorization is not run approval. Use local checks where sufficient; never bypass branch protection or report skipped checks as passed. See `.github/ACTIONS_POLICY.md`.

# Agent entry points

Before preparing, merging or publishing a CLI release, read [docs/NPM_RELEASE.md](docs/NPM_RELEASE.md) and the current `.github/workflows/cd.yml`. Publication and channel synchronization are manual; a merge alone does not publish. Preserve existing changes and confirm the authorized distribution channel; `latest` is stable and `next` is preview.

Do not put tokens, OTPs or passkey material in chat or repository files.
