## Scope
Publish the reviewed N/G candidate 2.1.33 to `next` for dev cross-host testing. This is not a stable release or complete transaction acceptance.

## Changes
- Preserve whole-journey selection, actual human consent, quoted names, and actionable booking recovery.
- Preserve endpoint identity and constraints; return finite location reasons and complete correction templates.
- Share one pre-query endpoint/route brief across Skill, Buyer docs and input exits.
- Local checkout display support does not install simulated authorization/payment/fulfillment in dev. Dev Backend/Worker use the normal build.

## Evidence
Candidate source: dbf84ecd8523cb4cb9ae67e43a327d90165f6caa.
Candidate tarball SHA-256: 0afd2d51bdff04060341915984ea9c7528e6846c0f6d73cd27182bb2e0b8a6e8.
CLI 348 checks passed with zero skips; compiled text/JSON exits reviewed; five channel bundle checks 21 passed.
CI must pass on this PR before merge. Main merge publishes via existing OIDC CD with publishConfig.tag=next. Do not publish in parallel or move latest.

## Deployment dependency
Compose must deploy the matching API/Booking v4 publication before business testing. Current dev still runs 6521caab with Booking v2. Natural host UX remains independently unobserved for this release.
