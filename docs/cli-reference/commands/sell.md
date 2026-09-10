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

- The current runtime accepts bounded, acyclic, single-entry workflows with multiple API nodes. Free queries can use quota and explicit human confirmation; paid workflows use one payment node and either fixed per-call pricing or a trusted pre-payment dynamic quote. Prepaid balance billing remains unsupported.
- Protected railway fulfillment resumes through the platform booking Owner only after verified payment and Web passenger confirmation. A standalone API probe cannot supply a payment identity or passenger records. Follow the server Guide for actual acceptance and publication blockers; local graph validation is not live ticket-issuance evidence.
- Local reports are diagnostics, not platform approval evidence. Platform verification is required; existing valid evidence may be reused. Admin approval never repeats Provider calls.
- Every visual view reads the same YAML. Layout is presentation only.
- Disclosure/confirmation binds the version being acted on. Do not turn `--confirm` into blanket permission for later changes.
- Never approve real submissions or perform real payments in automated development tests.

## Local recovery and packaging

The local `.itpay-sell` directory contains private fixtures, reports and the encrypted run journal's local key. Exclude it from Git and shared artifacts. A terminated process may leave `runner.lock`; inspect the journal and ensure no runner is active before manual recovery. A request with an unknown outcome is never automatically replayed.

Local reports never substitute for the platform verification gate. Repeated upload of an unchanged saved version reuses its cloud version; a changed cloud revision or fixture revision requires explicit pull/review.

For CLI repository builds, run `node scripts/fetch-sell-runtime.mjs` to obtain the exact checksummed native runtime in `seller-runtime.lock.json`, then `npm run test:package`. The committed `assets/sell-preview` directory supplies the local Builder. Packaging rejects missing native binaries or preview assets; do not substitute an arbitrary local binary for the locked release.

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

## Command reference

### itpay sell

Create, test and submit your service for review

```text
Usage: itpay sell [options] [command]

Create, test and submit your service for review

Options:
  -h, --help        display help for command

Commands:
  status [options]  List existing merchant memberships
  guide [options]   Read authoritative publication blockers and next actions
  library
  sources
  credentials
  services
  workflow
  fixtures
  pricing
  verify [options]  Start platform verification for an explicitly saved version
  runs
  submission
  init [options]    Local Sell: init
  config [options]  Local Sell: config
  test
  push [options]
  pull [options]
  mcp [options]     Serve local Seller MCP over stdio
  help [command]    display help for command
```

### itpay sell status

List existing merchant memberships

```text
Usage: itpay sell status [options]

List existing merchant memberships

Options:
  --json               Structured output
  --input-json <file>  Request fields as JSON
  -h, --help           display help for command
```

### itpay sell guide

Read authoritative publication blockers and next actions

```text
Usage: itpay sell guide [options]

Read authoritative publication blockers and next actions

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell library



```text
Usage: itpay sell library [options] [command]

Options:
  -h, --help        display help for command

Commands:
  search [options]  Search available API contracts
  get [options]     Inspect an API contract
  help [command]    display help for command
```

### itpay sell library search

Search available API contracts

```text
Usage: itpay sell library search [options]

Search available API contracts

Options:
  --json               Structured output
  --input-json <file>  Request fields as JSON
  -h, --help           display help for command
```

### itpay sell library get

Inspect an API contract

```text
Usage: itpay sell library get [options]

Inspect an API contract

Options:
  --json                    Structured output
  --input-json <file>       Request fields as JSON
  --library-api-id <value>  library_api_id
  -h, --help                display help for command
```

### itpay sell sources



```text
Usage: itpay sell sources [options] [command]

Options:
  -h, --help         display help for command

Commands:
  list [options]     List imported API sources
  inspect [options]  Inspect imported operations and verification results
  import [options]   Import an OpenAPI source without inventing request
                     contracts
  library [options]  Bind a platform library source
  probe [options]    Verify selected API requests on the platform
  add [options]      Local Sell: sources add
  help [command]     display help for command
```

### itpay sell sources list

List imported API sources

```text
Usage: itpay sell sources list [options]

List imported API sources

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell sources inspect

Inspect imported operations and verification results

```text
Usage: itpay sell sources inspect [options]

Inspect imported operations and verification results

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --intake-id <value>    intake_id
  -h, --help             display help for command
```

### itpay sell sources import

Import an OpenAPI source without inventing request contracts

```text
Usage: itpay sell sources import [options]

Import an OpenAPI source without inventing request contracts

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell sources library

Bind a platform library source

```text
Usage: itpay sell sources library [options]

Bind a platform library source

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell sources probe

Verify selected API requests on the platform

```text
Usage: itpay sell sources probe [options]

Verify selected API requests on the platform

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --intake-id <value>    intake_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell sources add

Local Sell: sources add

```text
Usage: itpay sell sources add [options]

Local Sell: sources add

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell credentials



```text
Usage: itpay sell credentials [options] [command]

Options:
  -h, --help        display help for command

Commands:
  status [options]  Read credential bindings without secret values
  bind [options]    Local Sell: credentials bind
  upload [options]  Local Sell: credentials upload
  help [command]    display help for command
```

### itpay sell credentials status

Read credential bindings without secret values

```text
Usage: itpay sell credentials status [options]

Read credential bindings without secret values

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell credentials bind

Local Sell: credentials bind

```text
Usage: itpay sell credentials bind [options]

Local Sell: credentials bind

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell credentials upload

Local Sell: credentials upload

```text
Usage: itpay sell credentials upload [options]

Local Sell: credentials upload

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell services



```text
Usage: itpay sell services [options] [command]

Options:
  -h, --help        display help for command

Commands:
  list [options]    List own service drafts and publication state
  create [options]  Create a platform service draft
  icon [options]    Upload a PNG/JPEG service icon, max 512 KiB, as signed JSON
  get [options]     Read the current workflow and service settings
  help [command]    display help for command
```

### itpay sell services list

List own service drafts and publication state

```text
Usage: itpay sell services list [options]

List own service drafts and publication state

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell services create

Create a platform service draft

```text
Usage: itpay sell services create [options]

Create a platform service draft

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell services icon

Upload a PNG/JPEG service icon, max 512 KiB, as signed JSON

```text
Usage: itpay sell services icon [options]

Upload a PNG/JPEG service icon, max 512 KiB, as signed JSON

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell services get

Read the current workflow and service settings

```text
Usage: itpay sell services get [options]

Read the current workflow and service settings

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell workflow



```text
Usage: itpay sell workflow [options] [command]

Options:
  -h, --help                   display help for command

Commands:
  catalog [options]            Read exact supported node templates and required
                               configuration
  plan [options]               Explicitly use ItPay AI planning and platform
                               verification
  plan-get [options]           Read the AI candidate and diagnostics
  plan-apply [options]         Apply a reviewed AI candidate to the draft
  upload [options]             Update the platform workflow with optimistic
                               concurrency
  validate-platform [options]  Validate using the same public runtime rules as
                               approval
  versions
  import [options]             Local Sell: workflow import
  validate [options]           Local Sell: workflow validate
  confirm [options]            Local Sell: workflow confirm
  preview [options]
  help [command]               display help for command
```

### itpay sell workflow catalog

Read exact supported node templates and required configuration

```text
Usage: itpay sell workflow catalog [options]

Read exact supported node templates and required configuration

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell workflow plan

Explicitly use ItPay AI planning and platform verification

```text
Usage: itpay sell workflow plan [options]

Explicitly use ItPay AI planning and platform verification

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell workflow plan-get

Read the AI candidate and diagnostics

```text
Usage: itpay sell workflow plan-get [options]

Read the AI candidate and diagnostics

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --run-id <value>       run_id
  -h, --help             display help for command
```

### itpay sell workflow plan-apply

Apply a reviewed AI candidate to the draft

```text
Usage: itpay sell workflow plan-apply [options]

Apply a reviewed AI candidate to the draft

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --run-id <value>       run_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell workflow upload

Update the platform workflow with optimistic concurrency

```text
Usage: itpay sell workflow upload [options]

Update the platform workflow with optimistic concurrency

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell workflow validate-platform

Validate using the same public runtime rules as approval

```text
Usage: itpay sell workflow validate-platform [options]

Validate using the same public runtime rules as approval

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell workflow versions



```text
Usage: itpay sell workflow versions [options] [command]

Options:
  -h, --help                 display help for command

Commands:
  list-platform [options]    List explicitly saved platform versions
  save-platform [options]    Save an explicit immutable platform version
  delete-platform [options]  Delete an eligible saved version and its runs
  save [options]             Local Sell: workflow versions save
  list [options]             Local Sell: workflow versions list
  use [options]              Local Sell: workflow versions use
  delete [options]           Local Sell: workflow versions delete
  help [command]             display help for command
```

### itpay sell workflow versions list-platform

List explicitly saved platform versions

```text
Usage: itpay sell workflow versions list-platform [options]

List explicitly saved platform versions

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell workflow versions save-platform

Save an explicit immutable platform version

```text
Usage: itpay sell workflow versions save-platform [options]

Save an explicit immutable platform version

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell workflow versions delete-platform

Delete an eligible saved version and its runs

```text
Usage: itpay sell workflow versions delete-platform [options]

Delete an eligible saved version and its runs

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --version-id <value>   version_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell workflow versions save

Local Sell: workflow versions save

```text
Usage: itpay sell workflow versions save [options]

Local Sell: workflow versions save

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow versions list

Local Sell: workflow versions list

```text
Usage: itpay sell workflow versions list [options]

Local Sell: workflow versions list

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow versions use

Local Sell: workflow versions use

```text
Usage: itpay sell workflow versions use [options]

Local Sell: workflow versions use

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow versions delete

Local Sell: workflow versions delete

```text
Usage: itpay sell workflow versions delete [options]

Local Sell: workflow versions delete

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow import

Local Sell: workflow import

```text
Usage: itpay sell workflow import [options]

Local Sell: workflow import

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow validate

Local Sell: workflow validate

```text
Usage: itpay sell workflow validate [options]

Local Sell: workflow validate

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow confirm

Local Sell: workflow confirm

```text
Usage: itpay sell workflow confirm [options]

Local Sell: workflow confirm

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell workflow preview



```text
Usage: itpay sell workflow preview [options]

Options:
  --project <directory>  Project directory (default: ".")
  -h, --help             display help for command
```

### itpay sell fixtures



```text
Usage: itpay sell fixtures [options] [command]

Options:
  -h, --help      display help for command

Commands:
  get [options]   Read test inputs
  set [options]   Save explicit test inputs
  help [command]  display help for command
```

### itpay sell fixtures get

Read test inputs

```text
Usage: itpay sell fixtures get [options]

Read test inputs

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell fixtures set

Save explicit test inputs

```text
Usage: itpay sell fixtures set [options]

Save explicit test inputs

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell pricing



```text
Usage: itpay sell pricing [options] [command]

Options:
  -h, --help      display help for command

Commands:
  get [options]   Read the current price and refund policy
  set [options]   Set per-call price and platform refund policy
  help [command]  display help for command
```

### itpay sell pricing get

Read the current price and refund policy

```text
Usage: itpay sell pricing get [options]

Read the current price and refund policy

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell pricing set

Set per-call price and platform refund policy

```text
Usage: itpay sell pricing set [options]

Set per-call price and platform refund policy

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  -h, --help             display help for command
```

### itpay sell verify

Start platform verification for an explicitly saved version

```text
Usage: itpay sell verify [options]

Start platform verification for an explicitly saved version

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell runs



```text
Usage: itpay sell runs [options] [command]

Options:
  -h, --help         display help for command

Commands:
  get [options]      Inspect platform test nodes and diagnostics
  confirm [options]  Confirm the exact disclosed platform test side effects
  help [command]     display help for command
```

### itpay sell runs get

Inspect platform test nodes and diagnostics

```text
Usage: itpay sell runs get [options]

Inspect platform test nodes and diagnostics

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --run-id <value>       run_id
  -h, --help             display help for command
```

### itpay sell runs confirm

Confirm the exact disclosed platform test side effects

```text
Usage: itpay sell runs confirm [options]

Confirm the exact disclosed platform test side effects

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --run-id <value>       run_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell submission



```text
Usage: itpay sell submission [options] [command]

Options:
  -h, --help          display help for command

Commands:
  preview [options]   Read publication readiness and required agreements
  submit [options]    Submit the confirmed version for review, never approve it
  get [options]       Read the actual review/publication result
  withdraw [options]  Withdraw own pending submission
  watch [options]
  help [command]      display help for command
```

### itpay sell submission preview

Read publication readiness and required agreements

```text
Usage: itpay sell submission preview [options]

Read publication readiness and required agreements

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  -h, --help             display help for command
```

### itpay sell submission submit

Submit the confirmed version for review, never approve it

```text
Usage: itpay sell submission submit [options]

Submit the confirmed version for review, never approve it

Options:
  --json                 Structured output
  --input-json <file>    Request fields as JSON
  --merchant-id <value>  merchant_id
  --draft-id <value>     draft_id
  --confirm              User explicitly confirmed the disclosed version/action
  -h, --help             display help for command
```

### itpay sell submission get

Read the actual review/publication result

```text
Usage: itpay sell submission get [options]

Read the actual review/publication result

Options:
  --json                   Structured output
  --input-json <file>      Request fields as JSON
  --merchant-id <value>    merchant_id
  --submission-id <value>  submission_id
  -h, --help               display help for command
```

### itpay sell submission withdraw

Withdraw own pending submission

```text
Usage: itpay sell submission withdraw [options]

Withdraw own pending submission

Options:
  --json                   Structured output
  --input-json <file>      Request fields as JSON
  --merchant-id <value>    merchant_id
  --submission-id <value>  submission_id
  --confirm                User explicitly confirmed the disclosed
                           version/action
  -h, --help               display help for command
```

### itpay sell submission watch



```text
Usage: itpay sell submission watch [options]

Options:
  --merchant-id <id>
  --submission-id <id>
  --timeout <seconds>   Maximum wait (default: "120")
  --json
  -h, --help            display help for command
```

### itpay sell init

Local Sell: init

```text
Usage: itpay sell init [options]

Local Sell: init

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell config

Local Sell: config

```text
Usage: itpay sell config [options]

Local Sell: config

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell test



```text
Usage: itpay sell test [options] [command]

Options:
  -h, --help        display help for command

Commands:
  run [options]     Local Sell: test run
  resume [options]  Local Sell: test resume
  get [options]     Local Sell: test get
  help [command]    display help for command
```

### itpay sell test run

Local Sell: test run

```text
Usage: itpay sell test run [options]

Local Sell: test run

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell test resume

Local Sell: test resume

```text
Usage: itpay sell test resume [options]

Local Sell: test resume

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell test get

Local Sell: test get

```text
Usage: itpay sell test get [options]

Local Sell: test get

Options:
  --project <directory>        Project directory (default: ".")
  --file <file>
  --url <https-url>
  --name <name>
  --service-id <id>
  --provider-key <key>
  --profile <id>
  --merchant-id <id>
  --environment <environment>
  --version-id <id>
  --run <id>
  --confirm
  --json
  -h, --help                   display help for command
```

### itpay sell push



```text
Usage: itpay sell push [options]

Options:
  --project <directory>  Project directory (default: ".")
  --merchant-id <id>
  --draft-id <id>
  --bindings <file>      Local profile ID to platform credential profile ID map
  --confirm
  --json
  -h, --help             display help for command
```

### itpay sell pull



```text
Usage: itpay sell pull [options]

Options:
  --project <directory>  Project directory (default: ".")
  --merchant-id <id>
  --draft-id <id>
  --bindings <file>      Local profile ID to platform credential profile ID map
  --confirm
  --json
  -h, --help             display help for command
```

### itpay sell mcp

Serve local Seller MCP over stdio

```text
Usage: itpay sell mcp [options]

Serve local Seller MCP over stdio

Options:
  --stdio
  --project <directory>  Project directory (default: ".")
  -h, --help             display help for command
```

## Seller login and dev

Use `ITPAY_BACKEND_URL=https://dev.itpay.ai itpay sell auth login --json` to receive the normal ItPay authorization link. After browser login and required email verification, run `ITPAY_BACKEND_URL=https://dev.itpay.ai itpay sell auth status --json`. The CLI claims its own account session through the standard API and stores it in an owner-only file; never copy tokens or browser cookies. `itpay sell auth logout --json` revokes this session. Keep the same backend prefix on subsequent commands; production, dev, and sandbox state are isolated. Agent device enrollment does not grant Seller organization access.
