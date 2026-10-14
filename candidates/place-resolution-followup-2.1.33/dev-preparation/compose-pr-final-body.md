Preserves the N/G product repairs and activates the existing journey-repair publication (Booking v4, Smart v6, Exact v1) using a new immutable Platform Release with published CLI 2.1.33 compatibility. Normal Backend/Worker/Web assembly excludes local simulation. Fixes administrative area contract checks; Planner 515 tests passed without skips. Published CLI integrity/contract evidence and release validation passed. Main/OAuth backups restored successfully in isolated network-none containers. No dev fresh, schema migration, stable npm release, or real transaction operations. Merge only after required CI and database checks succeed; observe the existing dev CD once.


## Deployment outcome

- Reviewed head: 20ee1c733a9df484739f71b8acc7d297b30cef9e; normal merge and actual dev revision: 45175400703c8ecaf846a000678866fac00b4634.
- PR CI/database and main CI/database succeeded. Dev CD [36997254948](https://github.com/itpay-ai/compose/actions/runs/36997254948), attempt 2, succeeded. Attempt 1 had a canceled remote build and hanging SSH; verified no active deployment process and unchanged old release before canceling and sequential rerun. Pending duplicate 36997263635 canceled before jobs started.
- Runtime images and all 33 Planner top-level modules match the merge. Backend/Worker share the target image; ordinary binaries and Web assets exclude local simulation.
- Unique active platform_v3_20261002_1; publication platform-services-2026-10-01.journey-repair-v1; Booking v4, Smart v6, Exact v1. schema_action=skipped, marker matches, db-release exit 0; no migration or dev fresh.
- CLI PR #87 independently merged/published via OIDC; next=2.1.33, latest=2.1.1; published gitHead 03e40e1b0e47b60feb2d5f83addddeed9ae1aef7. SHA-256 0afd2d51bdff04060341915984ea9c7528e6846c0f6d73cd27182bb2e0b8a6e8. Isolated installation, compiled output, Skill and Buyer docs verified.
- Scope remains dev cross-host testing. No real transactions or stable release; natural host UX not signed off.
