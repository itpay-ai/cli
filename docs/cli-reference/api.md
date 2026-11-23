# API Hub CLI

Use the same installation launcher and absolute --profile selector for every call. `itpay` below means that installation's exact launcher, not a second global installation.

## Quick start: published installation

Install through [the official dev entry](https://dev.itpay.ai/agent), read its installation instructions, and use the packaged `itpay-api` Skill. New setup returns one unified authorization page: the requested item is primary, the other item is checked by default and cancellable. Display the link immediately and run the returned wait command in the same profile. Only connected/authenticated is success; a browser callback alone is insufficient.

This release is immutable **0.2.72** and includes `--payer-currency`, `--refund-latest`, `--refund-request`, `--refund-status` and `--confirm` as documented by its installed help. Keep the original launcher/profile. Direct npm installs retain app.itpay.ai as the package default; the official dev entry persists dev configuration. Publication and installed version must be checked separately from source.

For a newly connected installation, begin with `api categories` or `api list`. Select an ID actually returned by discovery, run `api show`, explain purpose, price, result TTL and effects, then obtain the applicable consent before `api call`. The `operation_id`, input and original request ID must come from those responses; examples containing placeholders are not ready-to-run commands. Read the result and charge with `api status`. Supplier definitions and dev Beta availability follow their actual acceptance; a prepared definition alone is not a successful call.

## Common tasks and six business commands

|Command|Behavior|
|---|---|
|api categories|Real categories, including empty shelves.|
|api list [--category <id/slug/label>] [--query <text>] [--limit <1..100>] [--cursor <cursor>]|The website's saleable products, filtered before pagination.|
|api show <operation_id>|Purpose, price, JSON example and result TTL. Saves this installation's displayed publication.|
|api call <operation_id> --input <JSON/@file/->|After consent, submit using the shown price and publication.|
|api call --pending <original_local_handle>|Read and, when eligible, continue this installation's original request. Each wait round is at most 120 seconds.|
|api status <request_id> [--wait 0..120]|Read-only original receipt, result and charge; default0, unknown/reconciling returns immediately.|
|api wallet|Account available/held credit, selected credential kind/masked account and official wallet URL.|
|api wallet --usage|Current Key/Consumer gross/net/refunded/held usage; runs include failures.|
|api wallet --transactions|Scoped charge/refund rows with limit/truncation; owner_billing_url opens full account history.|

All support --json. setup --api-prefix prepares the installation and points to api connect. A fresh connection uses one unified confirmation page (primary plus default checked, cancellable other item), then waits and resumes. connect continue/status/restart remain supported for the original existing Device recovery only; keep its exact returned action and profile. Explicit rejection of refresh returns the original profile's connect --request command. Immediately follow the emitted waiting command. Successful reconnection returns status of the same original request, which can then return call --pending.

Show purpose, price and TTL before obtaining consent. A publication change requires reading the original receipt and showing the new price. A network-unknown write permits only original status reads. A failed call is reported as zero charge only when captured and held are both confirmed zero. Source result expiry does not remove fee facts.

The developer credentials import, admin and doctor commands are outside the six business commands. Services/cart/buy/checkout keep their separate authority and entry points.

A `price_changed` receipt includes `current_price` (CNY, scale 6, atoms) and verified original captured/held facts. When both are zero, the next command is show; explicit new-price consent is required before a new call. The ended original remains readable with status and has no stale funding handoff.

### API Key

Use a secret manager to inject ITPAY_HUB_KEY or pipe a private secret source to `itpay api credentials import --json`. Never pass the secret in argv or chat. With --profile, import into that same installation; an explicit environment Key remains selected. It does not need OAuth. Saved OAuth and Key remain private; the last explicit import/connect selects the credential, while a Key environment override selects that Key. Supplying both environment bearer and Key is an error. Requests remain isolated by original credential; neither a new Key nor OAuth can take over old requests.

Check `wallet` identity.account_hint and credential_kind; matching hints identify the same wallet, not the same consumer. Invalid/revoked Key or insufficient Key scope points to the official /me/keys page, without OAuth fallback. Hub MCP accepts Key only through its existing X-ItPay-Key protocol header; normal ChatGPT MCP uses OAuth. Do not paste a Key into chat or put it in a Bearer field. Services identity is independent.


### 本人钱包与 credit（公开包：人民币）

`itpay api wallet --topup 30 --json` 准备本人钱包的人民币请求，按实际环境的服务端报价，正式最低 ¥10、已批准 dev 最低 ¥1。保持用户原始正金额输入，低于最低时照读返回的 minimum_applied/notice、实际支付与 credit 金额，不在客户端硬编码调额。若关联已有挂起请求，加 `--request <原 request_id>`；付款后按返回 next 读取原钱包记录 并继续原 call --pending。CLI 在宿主可打开浏览器时主动打开官方 page_url，同时返回 checkout_url 和 image。`--no-open` 用于无浏览器打开能力的宿主。`wallet --topup-status <topup_id>` 只读原钱包记录。OAuth/API Hub Key 准备钱包请求 不要求消费 grant；钱包操作不会增加调用额度、商户收款或退款权限。

仅在用户明确要求为本人钱包增加 credit 并指定金额时，才准备对应官方付款。ChatGPT 只提供中性的账号状态和原请求下一步。
四档只是快捷项；每个钱包/码链接标“当前账号：名字 · 末6位”。

## Credit amounts and reporting

Balances, API quotes, holds and charges are in credit: **1 credit = ¥1 equivalent**. Quote users in credit first; when useful add “approximately ¥X”. Do not call an API balance cash or tell users to add money. With USD or another supported purchase currency, the server converts the actual fiat payment into credit using the frozen exchange rate at purchase time. Show fiat paid on the payment page and credit received on the receipt; never calculate a substitute FX quote.

When credit is insufficient, report the account state and preserve the returned original wallet/intent link and recovery command. Do not create a purchase or suggest an amount without explicit user intent. Preserve authorization, budget, request and idempotency identity. Purchasing credit never increases a spending grant. Machine fields `currency`, `scale`, `amount_atoms`, `captured_atoms` and `held_atoms` stay unchanged; CNY/scale 6 wire values represent the same credit equivalent, with 1,000,000 atoms per credit. Services tickets, merchant collections and cash refunds retain their actual fiat currency.

### Original-wallet refunds (local candidate; no npm release)

`itpay api wallet --refund-latest --json` reads the server preview and saves a local draft request ID. Only explicit user refund intent permits `--refund-latest --refund-request <saved-id> --confirm`; neither amount nor destination is accepted. A first confirmation saves sent/unknown before POST. Repeating the same ID (even the same confirmation command after a newer credit arrives) only GETs its original binding. `--refund-status <saved-id>` is readonly and must belong to this installation/profile. A distinct explicitly confirmed new ID may select the newer latest original; uncertainty never grants that intent. Normal verified OAuth only; Keys do not switch credentials or borrow browser sessions. Actual source, credit/CNY, used/occupied/reason and unrecorded payer hints come from the shared Hub response; ItPay suffix is not the payment-account suffix. Pending/unknown is not cash receipt.

The saved draft includes the exact server-preview topup_id. Latest confirmation sends that original ID as a server-enforced precondition under the account lock, without money/destination. A newer credit before first acceptance returns refund_preview_changed with zero refund/hold; this requires a fresh preview and new explicit user consent. Accepted old IDs still recover their original. A draft missing its preview cannot confirm.

A definitive refund submission rejection (for example403 original_connection_required) is reported as the original error with a nonzero exit, and persisted under the same sent request key. Repeating confirmation never resubmits; readonly status may check that key and retains the rejection when no request is recorded. Transport uncertainty, HTTP408/425 and server failures retain unconfirmed recovery by original key. Neither rejection nor uncertainty permits replacing the key or connection without a new explicit user intent.

Credit purchase reuse follows original payment_status, with legacy refund-status compatibility. A new explicit same-amount --topup first reads its known original: a completed purchase is archived under its original ID before a new key is created; an uncertain read preserves the original. Effective unpaid originals remain reusable. --topup-status only reads its original, including refund progress, and cannot create a new purchase. Paid/refunding/refunded originals provide no checkout action, payment image or payment instruction; refund progress never resumes an original pending API call as if its returned credit remained available.

`wallet --topup 10 --payer-currency USD --json` requests10 credit with server-quoted USD cash; `--payer-currency CNY` is the default. USD requires an admitted Stripe test buyer/profile and configured FX; unavailable channels fail without fallback. Read actual frozen `payer_currency`/`payer_minor_amount`, never convert credit locally. Currency is persisted before POST; USD retries use their own stable funding key, while existing CNY files and original read-only receipts remain valid. Do not add --payer-currency to --topup-status or refund commands. Buying credit changes no spending grant. This is candidate command support; actual channel availability depends on the paired server and separate sandbox acceptance.

## My API and My Key

Use the normally signed-in website: `/me/apis` imports and prepares a private OpenAPI operation; `/me/credentials` manages its supplier My Key. `/me/keys` instead manages ItPay API keys (`itk_`), which authenticate the caller to ItPay. Neither key belongs in chat, command arguments or logs. My API preparation is not an additional public CLI upload/publish command.

The accepted private BYOK path is owner-only `generic_https_json` with one header/query API key or HTTP bearer authentication. GET/HEAD retain their normal preparation path; other methods require the owner’s explicit `effect_class=read_only` declaration on the selected private authoring operation or preparation action and must pass the existing supported-request checks. Hub charges 0 credit for this supported own-key path; the supplier may charge separately. Do not infer that every provider, write operation or priced native workflow is free. Missing, rotated or revoked supplier keys do not fall back to platform credentials. Read original receipts without re-executing; another account cannot take over the private operation.

## Error → next action

|Outcome|Next action|
|---|---|
|Pending, timeout, cancelled or unknown after submission|Keep the original profile, identity and request; run only its returned status/recovery command. Never submit a replacement to discover whether it succeeded.|
|Authorization denied or budget exhausted|Use the returned authorization/settings action; funding cannot expand permission or budget. Do not switch to OAuth, another Key or MCP to bypass it.|
|Price/publication changed before acceptance|Read the original receipt, inspect the current publication and obtain fresh applicable consent before a genuinely new call.|
|Missing/revoked supplier My Key|Open My Key in the normal account session; preserve original/unknown runs. No platform-key fallback.|
|Result expired|Report expiry and retain original charge facts; do not silently call again.|
|Not found/not visible|Check the original account and returned operation; do not guess IDs or expose another account's private API.|

## Verification boundary / release follow-up

Source/help checked against CLI main `eec7253` and Coding's published-package comparison on 2026-11-18. Existing accepted reports cover controlled My API/My Key GET/HEAD with zero Hub credit, Stripe **test-mode** original Checkout/refund, and scoped display repair; they do not prove all providers or Agent hosts. WeChat real Native remains pending merchant confirmation and separately authorized real testing. Stripe live is not accepted. Reviewer simulation is separate from actual Stripe sandbox evidence.

Testing must rerun the six-command discovery→show→consented call→original status flow with the exact public package and a permitted dev account, check authorization recovery and errors, and separately check candidate-only refund/USD examples against source `eec7253` (not the registry package). Do not create new financial transactions merely to refresh examples. On an approved future release, update this availability paragraph, both packaged Skills, README and the official Agent guide together; fixed downloads/pins and publication require their own authorization.

New calls may explicitly select `--credential-mode platform`; omitted mode uses the applicable account Key under the Hub contract. Never change the mode through `--pending`. A Key choice opens the original official account page; `api status <original_request_id> --wait 120` waits read-only while the browser records and resumes the choice. The CLI does not automatically choose credit or require a user reply after a browser decision. Publication and exact installed 0.2.72 remain separate checks; source changes alone do not prove public availability.

Device 单次额度不足时保留原请求，按正式 next 的 `api connect --request <原请求>` 在同一连接确认本次消费额度；授权后只读 `status --wait 120` 等原单。对已有执行、unknown/reconciling、普通404或无原scope证明的错误，不重新提交。历史明确准入前拒绝仅在服务端确认原scope未受理且同Device额度仍低于冻结平台报价时，按原next准备原intent；不改输入、价格、账号或请求ID。终态无必须继续步骤，仍可按需只读status。

For an original browser purchase absent from this installation's funding records, `wallet --topup-status <topup_id>` uses the existing account-owner wallet refund reader. It requires the normal OAuth owner connection, does not adopt/cache the order, reconcile a PSP or submit a refund, and preserves Key/restricted-client and foreign-account refusal. Locally recorded funding orders keep their original read and recovery path.

release only on a binding-checked authoritative terminal run with zero held atoms and no credential recovery: either the existing successful final settlement, or a failed/cancelled run explicitly settled free/released with captured_atoms=0. A conflicting explicit new call reads its same-profile original once, persists that receipt through the existing reader, and compares the pointer again before attaching; it never executes/continues the old run or loops. This allows the next query within the same user task while retaining all original receipts. Pending, unknown, inconsistent, held, captured failures, missing amount fields, credential recovery and cancellations without a run keep their active binding.
