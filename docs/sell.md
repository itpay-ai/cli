# Sell Agent guide

`itpay sell` is the Seller command namespace. Buyer `services` commands remain separate. Read `itpay sell guide --json` first, authenticate with `itpay sell auth login` and complete the standard ItPay browser login, then run `itpay sell auth status`, then use `sell status` to select the user's existing merchant. An unverified merchant must finish KYB and payout setup in the dashboard.

## Local-first workflow

1. `sell init --project <directory> --service-id <id> --name <name>` creates a local project. `sell config --file <json>` sets price, policy and explicit test fixtures. Never invent prices or required API inputs.
2. `sell library search/get` reads platform sources. `sell sources add --file <OpenAPI> --provider-key <key>` compiles local contracts with the platform importer. `sell workflow import --file <workflow.yaml>` preserves the submitted workflow and reports unsupported semantics. Read `sell workflow catalog` for supported node configuration.
3. Generate or modify `workflow.yaml` in the user's Agent using the exact source contracts. Bind `providerOperationVersionId`, credential profile and input/output mappings explicitly. The first workflow ID must equal the service ID. Missing mappings, incompatible schema, unsupported content types or unsupported workflow semantics block execution. Do not remove unknown fields to conceal a compatibility error.
4. `sell credentials bind --profile <id> --file <bindings.json>` accepts field-to-environment-variable mappings, never secret values. `sell credentials upload` uploads those environment values directly to the authenticated merchant after approval; values must not appear in chat, workflow files or generated docs. Platform-managed secrets cannot be downloaded.
5. `sell workflow validate`, then `sell workflow versions save --name <name>`. Runs never create saved versions. `sell test run --confirm` performs actual Provider calls on this machine, with simulated payment/refund/delivery gates. `sell test get --run <id>` reads results. `sell test resume` never blindly replays an unknown request.
6. `sell workflow preview` serves the existing Builder on loopback only. Review its exact YAML, price and version; then use `sell workflow confirm --confirm` only after user agreement.
7. `sell push --merchant-id <id> --bindings <profile-map.json> --confirm` uploads the confirmed package. Profile map values are platform profile IDs, not secrets. Optimistic revisions prevent overwriting another editor. An ambiguous write requires explicit pull/reconciliation, never guessed retries.
8. Inspect platform-imported operations and perform any required `sell sources probe` with explicit test inputs. Follow the backend Guide and the upload's returned version/revision fields to run `sell verify`. Disclose and confirm API side effects, including the exact risk hash if the platform returns an additional confirmation barrier.
9. `sell submission preview` returns the workflow, price, policy and current agreements. After user approval, `sell submission submit` sends the exact revision, terms version and required confirmations. This requests review; it does not publish or approve.
10. Use `sell submission get` and `sell services list/get` to follow the actual outcome. Rejected/withdrawn/taken-down services can be edited and resubmitted through the same process. Once published, verify with buyer `catalog list`.

All platform operations accept `--input-json <file>` for their declared fields and `--merchant-id`/`--draft-id` where appropriate. Run each command's `--help`; do not invent options. `sell guide --merchant-id <id> --input-json <file>` with `{"draft_id":"..."}` returns server-derived next actions.

## MCP

`itpay sell mcp --stdio --project <directory>` exposes local creation, import, versioning, testing, preview, sync and platform actions. It reuses the local CLI identity. Remote MCP exposes only platform actions and cannot read paths on the user's machine. Use the local server for real local tests and file access. New remote grants require the appropriate `itpay.seller.read/write/test/submit` scopes; old buyer grants do not gain Seller authority.

## Invariants

- Current public runtime is synchronous, acyclic, single entry, per-call pricing, one payment node, and delivery on success. Quota, prepaid consumption and async workflows are not publishable.
- Local reports are diagnostics, not platform approval evidence. Platform verification is required; existing valid evidence may be reused. Admin approval never repeats Provider calls.
- Every visual view reads the same YAML. Layout is presentation only.
- Disclosure/confirmation binds the version being acted on. Do not turn `--confirm` into blanket permission for later changes.
- Never approve real submissions or perform real payments in automated development tests.

## Local recovery and packaging

The local `.itpay-sell` directory contains private fixtures, reports and the encrypted run journal's local key. Exclude it from Git and shared artifacts. A terminated process may leave `runner.lock`; inspect the journal and ensure no runner is active before manual recovery. A request with an unknown outcome is never automatically replayed.

Local reports never substitute for the platform verification gate. Repeated upload of an unchanged saved version reuses its cloud version; a changed cloud revision or fixture revision requires explicit pull/review.

For repository builds, run `scripts/v3/build-sell-runtime.sh`, build `apps/web/vite.sell-preview.config.ts`, and then build/package `apps/cli`. Packaging rejects missing native binaries or preview assets. `scripts/v3/sync-sell-contract.mjs --check` verifies that the CLI command contracts match the backend/MCP package.

Example local MCP configuration (use the existing authenticated CLI account):

```json
{
  "mcpServers": {
    "itpay-sell": {
      "command": "itpay",
      "args": ["sell", "mcp", "--stdio", "--project", "/absolute/path/to/service"],
      "env": {"ITPAY_BACKEND_URL": "https://sandbox.itpay.ai"}
    }
  }
}
```

## Seller login and dev

Use `ITPAY_BACKEND_URL=https://dev.itpay.ai itpay sell auth login --json` to receive the normal ItPay authorization link. After browser login and required email verification, run `ITPAY_BACKEND_URL=https://dev.itpay.ai itpay sell auth status --json`. The CLI claims its own account session through the standard API and stores it in an owner-only file; never copy tokens or browser cookies. `itpay sell auth logout --json` revokes this session. Keep the same backend prefix on subsequent commands; production, dev, and sandbox state are isolated. Agent device enrollment does not grant Seller organization access.
