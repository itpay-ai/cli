# Agent UX Handoff — CLI Implementation Evidence

Implements the W0–W7 contract from
`compose:docs/reviews/agent-ux-handoff-2026-09-23/README.md` (PR #215,
branch `spec/agent-ux-human-handoff-20260923`). Scope: `@itpay/cli` only, plus
the one compose-side AUTH05 gate fix. No Planner V2 behavior changed; no new
payment path; protected Checkout remains the only identity/payment surface.

## W0 — Baseline fingerprint

| Item | Value |
|---|---|
| CLI baseline commit | `760d20420ab71b7df0e61540bf5fd93543bfeb5a` |
| Package version | `@itpay/cli@2.1.17` (already published to `next`) |
| Node / npm | v24.10.0 / 11.6.1 |
| Baseline tests | 292/292 pass at baseline |
| Post-change tests | 309/309 pass (`npm test`), `npm run test:package` → `packed CLI smoke passed` |
| Coverage gate | lines 85.79 / statements 85.79 / functions 93.24 / branches 77.06 — all above thresholds (85/85/90/70) |
| Compose side | AUTH05 gate change + unit test; `go build ./...` clean, `internal/app/identity` + `internal/adapters/postgres` tests pass |

## Contract preserved / extended

- `status`/`result`/`handoff`/`instruction`/`next`/`recovery` unchanged.
- New optional `interaction` (`itpay.interaction.v1`: `stage`, `by_goal`,
  `input_template`, `recipe`) and `communication` (`itpay.communication.v1`:
  `status_line`, `recommended_reason`, `human_steps`, `next_expectation`,
  `must_convey`).
- All nested `itpay ` command strings inside `result`, `handoff`,
  `interaction` and `communication` are qualified by `qualifyCommandsDeep`
  (Agent Type + Backend URL) at envelope write time (`src/commands/guidance.ts`).
- `next` is `null` whenever no fully-bound executable exists; unresolved
  values live in `input_template` with `required_input` + `executable:false`.

## Issue → fix → verification map

### AUTH (src/state/account_auth.ts, src/state/task_journal.ts, src/main.ts, tests/ux_envelope.test.ts)

| Issue | Fix | Test |
|---|---|---|
| AUTH01 pending compression | `stage` is reported verbatim; `email_verification_required`/`merge_confirmation_required` get distinct instructions | `AUTH01: distinct pending stages…` |
| AUTH02 completed→replaced | completed open session binds in place via stored start_token; no second auth session is created | `AUTH02: binds in place` (asserts zero POST to `/v1/dashboard/auth-sessions`) |
| AUTH03 transport→new session | poll/bind/绑定状态 transport failure → `auth_status_unknown`; saved session file preserved; no new request | `AUTH03: transport failure keeps the saved session…` |
| AUTH04 placeholder resume | `TaskJournal` (`~/.itpay-v3/tasks.<env>.json`) records paused executions; `authenticated` resumes the exact journaled command or explicitly says none exists | `AUTH04: resumes the exact journaled task` + `…says so instead of emitting a placeholder` |
| AUTH05 wallet login gate | compose: `RequireVerifiedContact` = phone OR email verified; Checkout-bound sessions keep Path B exemption | `TestDashboardWalletGateAcceptsPhoneOrEmailAndKeepsCheckoutExemption` |
| AUTH06 raw JSON output | `itpay auth login|status` goes through `writeCommandEnvelope` (qualified, human-readable non-JSON, clean `--json`) | exercised via `agentAuth` envelope assertions |
| AUTH07 status classification | `auth_session_missing` (404/410), `auth_status_unknown` (transport), `login_required` (no session), terminal states distinct (`auth_expired/denied/cancelled/failed`) | `AUTH07: server-side missing…` + `terminal auth states…` |
| SEC01 credential exposure | auth handoff marked `contains_credentials: true`; instruction forbids writing start_token into chat/logs | code review + handoff field assertion |

### W3 services continuity (src/commands/services.ts)

| Requirement | Implementation |
|---|---|
| Two-goal semantics | `interaction.by_goal.compare` (present ≤3 options, stop) / `prepare_checkout` (select under user rules → continue to official entry, no re-ask) on `query_results_ready` |
| No fake executable next | `select`/`book`/`<rank>`/`<file>` placeholders moved to `interaction.input_template`/`booking_template` with `executable:false`; `next` holds only fully-bound commands or `null` |
| Server-issued actions verbatim | `available_actions[]` copied through untouched |
| `planning` progress state | `communication` block (status_line/next_expectation/must_convey) without selection semantics |
| Booking review | `booking_review_required` keeps legs/seat_options/draft_revision/notice_version disclosure; consumes optional `review.web_review_url|entry_url` as `handoff` when the owner projects one (W4 web-review seam); chat consolidated review remains fallback; never fabricates approval |
| Journal writes | `runServicesNext` observes every envelope into `TaskJournal` |

### W5 presentation/relay (src/state/client_context.ts, src/commands/presentation.ts, src/render/browser.ts, src/commands/checkout.ts, src/main.ts)

| Requirement | Implementation |
|---|---|
| Context extension | `ViewerDevice`, `ExecutorLocality`, `ClientCapabilities`, `hostCapabilities()` — Agent Type is never used as viewer/executor proxy |
| Deterministic resolver | `resolvePresentation`: business blockers first (paid/refund/unknown-amount → `read_same_order`, expired quote → `recover_expired_quote`, policy → blockers); then 1 recommended + ≤2 alternatives; explicit choice honored only when feasible; failed routes never silently retried; unknown capability ≠ yes; QR never offered to the mobile device being looked at; remote executor can't open a local browser |
| `itpay checkout` flags | `--present auto\|browser\|image\|link\|none`, `--no-open`, `--viewer`, `--relay-option`, `--confirm-relay`, `--request-key`, `--relay-status`; present⊥relay mutually exclusive; `--json` plans without side effects, explicit `--present browser` is the display request |
| Browser opener | argv-array spawn (no shell), HTTPS official origins only, loopback only behind `ITPAY_CLI_DEV=1`, no userinfo/arbitrary schemes; `dispatch_accepted` ≠ `page_loaded` |
| Relay | `resolveRelay` enforces issued-option + request-key + explicit consent; backend capability absent → honest `unavailable`; `--relay-status` read-only |

## Evidence separation (per W0/W7)

| Class | Count | Where |
|---|---|---|
| In-process unit/contract tests (new) | 17 | `tests/ux_envelope.test.ts` |
| Existing suite updated to new contract | 9 assertions moved to `interaction.*` | `tests/smoke.test.ts` |
| Mock backend extended | auth sessions + binding endpoints + failure injection | `tests/mock_backend.ts` |
| Packed-package smoke | pass | `npm run test:package` |

## NOT executed — remains open for acceptance

- No target-agent (Astra/harness) runs against real models.
- No real browser/native-host display verification — only `isPresentableURL` +
  argv construction are unit-tested; `openInSystemBrowser` spawn is not e2e.
- No SMS/email/wallet relay test — backend relay endpoints do not exist; CLI
  returns honest `unavailable`.
- No payment/issuance/refund flow test — those owners were untouched.
- Tarball-installed CLI behavior verified only by `scripts/package-smoke.mjs`,
  not by a manual install run.
- The 72-check matrix from `VALIDATION.json` maps to implementation status
  here; actual model/host acceptance rows stay "not executed" — this document
  does not claim them.

---

## Addendum — 09 Checkout Lifecycle & UX Repair (compose `codex/checkout-lifecycle-ux`, base `59f95a1`)

Spec: `09-CHECKOUT-LIFECYCLE-AND-UX-REPAIR-20260927.md`. Implemented the
server-owned payment deadline, checkout-scoped phone reuse, in-page desktop QR,
and shared deadline projection; CLI consumes the same fields.

### Single payable deadline D (backend)

| Requirement | Implementation | Test |
|---|---|---|
| One deadline everywhere | `checkouts.expires_at` = `min(created_at + PaymentTTL(15m), earliest bound quote-lock expiry)` set in `CreateCheckout`; copied verbatim to `orders.payment_deadline_at` by `EnsurePendingOrderForAuthorizedCheckout`; legacy rows fall back to `PaymentDeadline(created_at, ttl, quote expiry)`, never re-anchored | `TestLifecycleSingleDeadlineRealPG`, `TestLifecycleEarlyQuoteWinsDeadlineRealPG` (real PG) |
| Refresh never extends | persisted `expires_at` wins; reused intents keep their expiry | same test: second intent call returns identical `expires_at`, zero extra provider calls |
| Expiry truly cancels | `ExpireStalePendingOrders` single-tx cascade: order→cancelled, checkout→expired, intents→expired, quote locks→expired, bindings→expired, executions→cancelled+event, display tokens→expired, auth sessions→expired; `FOR UPDATE SKIP LOCKED`; orphan executions swept only when no live payment path remains | `TestLifecycleExpirySweepCascadeRealPG`: pre-D no-op, post-D full cascade, repeat sweep idempotent |
| Paid protected | candidate scan requires `status='pending_payment'`; conditional UPDATE loses the race to a verified payment | `TestLifecyclePaidSurvivesAndLateCallbackReconcilesRealPG` |
| Late provider funds | `CompleteProviderPayment` returns `Reconciled:true`, persists funds evidence, never resurrects cancelled order | same test: late TRADE_SUCCESS after sweep → reconciled, order stays `cancelled` |
| New actions refused at D | `ErrPaymentWindowClosed` → HTTP 410 `payment_window_closed`; `<1min` remaining refuses new QR/wallet actions; `paymentActionExpiry = min(now+actionTTL, D)` clamped into provider `TimeoutExpress`/`time_expire` | unit tests in `internal/app/payment`, `internal/httpapi/handlers`; PG test asserts intent `expires_at = D` |

### Phone (checkout-scoped, privacy-preserving)

- `ports.BuyerProfile` exposes `LoginPhone`/`PhoneVerified`; presentation projects
  `account_phone_option` = `{source, masked_recipient}` only — the raw number
  never leaves the server.
- `order_contacts` rows are checkout-scoped: `InsertAccountOrderContact` copies
  the verified account phone under a row lock (refused on expired/terminal
  checkout, `ErrOrderContactLocked` once a payment action exists);
  `GetVerifiedOrderContact` feeds `RequireDeliveryContact` and the masked
  `verified_sms_contact` projection.
- Replacement phone = OTP-verified `order_contact` challenge; it never writes
  the account login phone. `UpdateDeliveryContact` gates `phone_source:
  account_phone` on a live buyer session and reads the account-side verified
  number server-side — client-submitted digits are not trusted.
- Real-PG tests: `TestLifecycleOrderContactScopeRealPG` covers reuse
  roundtrip, cross-checkout isolation, upsert versioning, post-payment lock,
  expired-checkout refusal.

### Shared projection & clients

- `CheckoutPresentation`/`Order`/buyer summaries emit `payment_deadline_at`,
  `server_now`, `payment_remaining_seconds`; expired pending orders project
  `cancelled` and drop the deadline field.
- Web: `paymentCountdown.ts` ticks from server values only (never extends);
  `PaymentDeadlineBadge` shared by OrdersPage/OrderDetailPage; CheckoutPage
  disables payment at zero and re-reads the backend; desktop Alipay QR renders
  in-page via `qrcode` with the copy "展示付款码不会直接扣款".
- CLI: `itpay checkout`/`itpay order` envelopes carry the same deadline fields;
  pending instructions state the exact deadline and that refresh does not
  extend it; expiry guidance routes to re-quote rather than replaying stale
  payment actions. `Order`/`CheckoutPresentation` types extended in
  `src/client/types.ts`.

### Harness fix (per §6)

- `ux_harness.py` interventions now classify `human_product_step` (login/OTP/
  passenger confirmation/QR scan — requires step+operator+scope+a same-order
  backend_observation in `verification_event_ids`) vs `engineering_rescue`
  (still fail); unclassified legacy entries stay conservative.
- `relative_file` no longer rejects runs under symlinked tempdirs (macOS
  `/var`→`/private/var`); symlink checks now apply inside the run dir only.
- Prompts updated (UI-OPERATOR/USER-SIMULATOR/ASTRA-REVIEWER/README).
- `test_harness.py` 25/25, including 6 new classification cases.

### Actually executed (this round)

- Backend unit: `go test ./internal/app/{checkout,payment,order,railbooking,identity} ./internal/presenter ./internal/httpapi/handlers` — all green.
- Real PG (`ITPAY_V3_TEST_DATABASE_URL`, isolated per-test DB): 6 new
  lifecycle tests + golden regression suite (`SearchSelectCheckoutGoldenFlow`,
  receipt aggregation, provider-failure, quota transition) — all green.
- Web: `npm run typecheck` clean; `npm test` 73/73.
- CLI: 309/309 tests (240 smoke + 69 unit), tarball package smoke previously
  green; contract/package `tsc` clean.
- Harness: `python3 -m unittest test_harness` 25/25.

### NOT executed (unchanged honesty)

- No real Alipay/WeChat channel call — fake `AlipayPaymentClient` records
  requests only; provider sandbox validation remains open.
- No real browser e2e of the QR modal / countdown; no real-device OTP.
- No deployed dev-environment verification of the new checkout path.
- Harness changes are structural (classifier + fixtures); no real triadic run
  was executed.
