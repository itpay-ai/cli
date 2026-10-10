# npm release runbook

## Current publication contract

`@itpay/cli` publishes from GitHub-hosted Actions using OIDC, with no `NPM_TOKEN` in the workflow. Read the current `cd.yml` before merging. GitHub environment `npm-publish` allows only `main`; it has no per-run human approval.

One-time npm package Settings → Trusted publishing setup:

- Provider: GitHub Actions
- Organization/user: `itpay-ai`
- Repository: `cli`
- Workflow filename: `cd.yml`
- Environment: `npm-publish`
- Enable **Allow npm publish** and **Allow npm dist-tag**. Stage-only permission does not permit unattended direct publication.

The package repository URL must be `https://github.com/itpay-ai/cli`. The workflow pins npm 11.21.0, which supports both OIDC publish and dist-tag. npm-side setup requires an authorized maintainer and may require one-time interactive authentication. Never claim setup complete merely because YAML is merged.

## Choose the channel explicitly

| Intent | Procedure |
| --- | --- |
| Stage a new main version | Version bump + checks + merge main publishes only to `candidate-dev`. `next/latest` remain unchanged. |
| Stage a maintenance candidate | First review the internal commit and artifact. Approve its exact SHA/version/API/tarball SHA-256 in `scripts/npm-release-sources.json` on main. Dispatch action `stage`, source `dev` or `prod`; null entries fail closed. |
| Activate dev channel | Verify matching Backend/runtime/publication; approve exact dev source in policy. Dispatch `promote`, tag `next`, exact version. |
| Activate stable channel | Validate the precise old-production combination in isolation and deploy its matching Backend. Approve exact prod source, then dispatch `promote`, tag `latest`, exact version. This is not automatic main-to-production promotion. |
| Verify OIDC without publishing | Dispatch `verify` for the current exact `next/latest` value; reasserts the same tag only. |

The trusted workflow always runs on protected main. Its source selection is an enum, never a caller-supplied ref. Main policy fixes internal maintenance commits and tarball hashes; changing those approvals requires a normal reviewed main PR. Do not swap main's product tree to publish an older API.

`candidate-dev/candidate-prod` are staging labels, not user installation channels. Only `next` serves dev; only `latest` serves production. A workflow-only change with unchanged package version does not publish or move final tags. Existing versions cannot be overwritten. On an uncertain npm result, inspect exact metadata, gitHead, integrity and tags; wait read-only for visibility, do not repeat publish or invent an authentication failure. Never run a second local publisher concurrently.

## Checks and evidence

`node --test scripts/npm-release.test.mjs scripts/npm-release-source.test.mjs` checks source and channel routing. The prepare job has read-only repository permissions, no npm environment or OIDC. It checks the exact approved checkout with `npm ci` and `npm run check`, then the trusted packer records source gitHead, compiled API, version and SHA-256. No candidate build script runs in the publish job.

The protected publish job checks out trusted main only, verifies downloaded artifact source/checksum/package metadata/compiled API, and publishes that exact tarball with scripts disabled. The artifact package records the actual source SHA as gitHead; this can differ from GITHUB_SHA (workflow revision). Promotion downloads the registry tarball from registry.npmjs.org, verifies the approved SHA-256 and registry integrity, and reads its actual gitHead/version/compiled API before moving a final tag. Do not bypass checks. No new dependency.

After each release, record workflow run, trusted main workflow SHA, actual source SHA, manifest/tgz SHA-256, action/channel/version, registry gitHead/integrity and dist-tags; verify installation in a temporary prefix, Skill and Buyer docs. For next, check latest did not move. Do not silently replace a user's global CLI or device identity.

An OIDC verify run exchanges GitHub identity for a temporary npm token and sends an actual same-value tag PUT; npm dist-tag add alone skips unchanged tags and cannot prove write permission. This proves tag permission only. `npm publish --dry-run` does not prove live publish authorization. The next authorized new-version release must confirm actual publish and provenance. Preserve the old unused NPM_TOKEN secret until OIDC publication has been verified; remove it afterward with account authorization. Do not add it back as a hidden fallback.

## Policy and fallback

Official references, checked 2026-10-01:
- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/about-access-tokens/
- https://docs.npmjs.com/cli/v11/commands/npm-trust/

Classic tokens were removed in November 2025. Granular bypass-2FA publication is still transitional, with removal planned for January 2027. Trusted publishing avoids this dependency. If human local publication is explicitly requested, use the current web/passkey flow; login success alone does not prove publication success. Never ask for tokens in chat.

## Historical activation snapshot (not current release evidence)

Workflow merged through PR #85 at b214ada7b9ef01570a55d45a5ef2019019b2fc01; GitHub main-only environment configured. Run 36859058141 completed, but its unchanged-tag CLI path skipped PUT and is not write-permission evidence. The corrected verify path must succeed before recording authorization as verified. No new version has been published through OIDC yet.
