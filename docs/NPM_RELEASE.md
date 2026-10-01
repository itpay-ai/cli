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
| Automatically release next | Bump package/lock version, retain `publishConfig.tag: next`, pass checks, merge into main. |
| Automatically release stable | With explicit stable-release authorization, bump version and set `publishConfig.tag: latest`, pass checks, merge main. This remains the automatic channel until changed. |
| Promote an already tested next version | Dispatch `cd.yml` on main: action `promote`, tag `latest`, version the exact published version. No rebuild or new version. |
| Manually publish a new main version | Dispatch action `publish`, explicitly choose `next` or `latest`; package.json supplies version. |
| Verify OIDC without publishing | Read registry tags, dispatch action `verify`, tag `next`, version its current exact value. Reasserts that same tag only. |

`general` is not the stable npm tag: use `latest`. Installing without a tag uses latest. Installing `@itpay/cli@next` uses next. Keeping automatic releases on next and explicitly promoting stable is the recommended routine.

A workflow-only change or a push with unchanged package version does not publish or move tags. Versions cannot be overwritten. If publish reports an uncertain result, read registry version/gitHead/dist-tags before retrying. Existing version from another revision fails rather than overwriting; promotion must be explicit. Publishing and local fallback must never run concurrently.

## Checks and evidence

`node --test scripts/npm-release.test.mjs` checks routing. New publication runs `npm ci` and `npm run check`, including runtime assets, compilation and packed smoke, before `npm publish --ignore-scripts`. Do not bypass these checks. There is no new dependency.

After each release, record workflow run, main SHA, action/channel/version, registry gitHead/integrity and dist-tags; verify installation in a temporary prefix, Skill and Buyer docs. For next, check latest did not move. Do not silently replace a user's global CLI or device identity.

An OIDC verify run exchanges GitHub identity for a temporary npm token and sends an actual same-value tag PUT; npm dist-tag add alone skips unchanged tags and cannot prove write permission. This proves tag permission only. `npm publish --dry-run` does not prove live publish authorization. The next authorized new-version release must confirm actual publish and provenance. Preserve the old unused NPM_TOKEN secret until OIDC publication has been verified; remove it afterward with account authorization. Do not add it back as a hidden fallback.

## Policy and fallback

Official references, checked 2026-10-01:
- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/about-access-tokens/
- https://docs.npmjs.com/cli/v11/commands/npm-trust/

Classic tokens were removed in November 2025. Granular bypass-2FA publication is still transitional, with removal planned for January 2027. Trusted publishing avoids this dependency. If human local publication is explicitly requested, use the current web/passkey flow; login success alone does not prove publication success. Never ask for tokens in chat.

## Activation status

Workflow merged through PR #85 at b214ada7b9ef01570a55d45a5ef2019019b2fc01; GitHub main-only environment configured. Run 36859058141 completed, but its unchanged-tag CLI path skipped PUT and is not write-permission evidence. The corrected verify path must succeed before recording authorization as verified. No new version has been published through OIDC yet.
