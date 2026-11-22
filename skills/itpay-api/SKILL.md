---
name: itpay-api
description: Browse the shared API market, call a shown product with consent, and read the original request and wallet.
---

# ItPay API

This package is official CLI 0.2.75. Development npm next uses the official dev installation entry and its persistent dev launcher. The package default remains app.itpay.ai; tags never move an existing profile. Install/upgrade in the original permitted prefix and keep the original account, device key and requests. Production latest is approved separately.

Use the official pinned CLI when this host permits execution. API calls and structured data use this Skill. Services, purchased delivery and aftercare use the separate Services Skill. Keep this installation's original launcher, profile, endpoint and real Agent Type across chats. A new chat keeps its existing identity.

The API business commands are categories, list, show, call, status and wallet. Connection and installation are separate. Use the selected installation from setup --api-prefix. Follow every returned next.command exactly, including its absolute --profile selector. Never clear credentials, change accounts or create a substitute request to recover quota or an unknown result.

## Start from the user's task

Do not ask the user to prepare ItPay first. If no CLI is installed, read https://dev.itpay.ai/agent inside the actual execution environment. Run the official `agent --task @<private-task-file> --surface api --json` entry, supplying your own actual `--agent-type` only when runtime detection needs it. This prepares this host's independent profile and saves the task before connection. Existing legacy profiles and credentials are preserved; never adopt another host's identity. Explicit existing request/profile continuations keep their original launcher instead.

Show the returned official link immediately. The entry emits the link and waits in the same call; use `--buffered` if this host cannot display streaming output, then run the returned next command immediately. Do not ask for permission to initiate the requested connection or tell the user to report "done". Only the person approves in the official page. `pending` or exit 0 is not connected. If the host ends the turn, any next reply resumes `agent` without a new task argument. Follow the saved original request status before continuing; an explicitly new user intent uses `--new-task`, retaining the prior receipt. Never restart after denial/cancellation without a new explicit intent.

## Find and consent

Use categories to read the website's real categories, including empty ones. Use list with the returned category ID or its label, and optional query. Follow the returned cursor for more products. Ordinary public shelves show USGS and Frankfurter. Test products appear only for a server-authorized test account with the server switch enabled.

Use show <operation_id> to read purpose, exact price, example input and result retention. Explain those facts and obtain consent before call. USGS time fields use absolute UTC ISO timestamps. Replace the example interval with the current requested interval, preserve the minimum magnitude and limit at most 100. Results capped at the limit are not an exhaustive catalogue. Frankfurter is daily reference data with its own date, not a live trading quote.

After consent use call <operation_id> --input '<JSON object>' (or @file / stdin). The CLI uses this installation's shown publication and price, saves the original request and supplies its ID. It does not re-inspect or invent a cap. A missing display requires show first. A price/publication change receipt shows the server-verified current price/currency and original zero-capture/zero-hold facts when confirmed. Keep the original request read-only, then show the current product and obtain explicit consent to the new price before a new call. If those facts are unavailable, status the original request first. Do not reuse the old price for a replacement.

## Follow the original request

status <request_id> [--wait 0..120] only reads the original result, receipt and charge. An unknown state remains unknown until the owner reports facts. A result whose body has expired still has its fee receipt. Never create a new call, recharge or claim failure from a missing result or a network timeout.

call --pending <request_id> is the returned continuation form for this installation's original request. It preserves the stored operation, input, publication and idempotency key. It first reads the original request, reads an existing run, and only continues an eligible original intent. It waits in rounds of at most 120 seconds. Follow its next command while the human completes the original official action. A terminal result or null next ends waiting. Do not invent a continuation for an unknown write.

If refresh is explicitly rejected, follow the returned connect --request command for the same profile. Immediately run the returned connect continue waiting command while the human approves the original official link. Keep -- before an opaque handle. Wrong-account approval stops. Once credentials are freshly verified and saved, the next command is status of the original request. Follow its call --pending only when continuation is actually required. Network-unknown refresh preserves the original state and does not authorize another login or business request.

## Wallet and payment

wallet reads available and held atoms and provides the official wallet URL. For “what have I used”, use wallet --usage or wallet --transactions: these report only the current Consumer/Key scope, with truncation where applicable. Known requests still use status. Full account funding, holds and cash refunds use owner_billing_url in the normal owner browser; do not use Computer Use to expand machine scope. Wallet credit balance is shared account credit, not this consumer's authorization cap. Insufficient credit balance uses the original intent's official credit purchase page and original call --pending wait command. Funding never increases an explicit spending cap.

Only prepare a credit purchase when the user explicitly gives a funding amount. Quick amounts are shortcuts, not allowed-amount limits; the server quotes the amount under its existing minimum and currency contract. A test channel must remain visibly marked as simulated. A page or callback does not prove wallet credit. Read the original server request and final charge. Do not create another payment or replacement intent.

Present only returned official links and branded cards or their official rendered images. Never reconstruct, crop or encode a payment QR, request credentials in chat, or expose tokens or private request bodies.

Read result.surfaces: enabled or consent_required. Pending is not approval. Follow the original next.command and launcher/profile; continue permitted work. Obtain missing consent on the same connection only when needed. Preserve original requests.

## API Key access

A user may securely inject ITPAY_HUB_KEY or import the selected Key with api credentials import through private stdin. Never ask for it in chat, put it in argv/logs, or echo it. A Key authorizes API Hub only within its catalog, effects and spending grant. It does not authorize Services or payment writes. An explicit environment Key wins over a saved OAuth connection; importing a Key selects it while preserving OAuth privately. An explicit normal connect selects OAuth. Never switch credentials to resume an existing request: its original task namespace remains isolated.

For an API task with a selected Key, agent prepares only that API installation and reads its identity without OAuth. Read wallet identity.credential_kind and account_hint before work; all hosts in a shared-wallet test must show the same hint. If mismatched, stop that new task and have the owner select the intended Key or normally reconnect the intended account; keep all existing requests and do not revoke another host. Invalid/revoked Key or insufficient scope directs the owner to /me/keys and secure stdin import, never automatic OAuth fallback. A credit purchase URL is navigation, not a created credit purchase; /hub/mcp is a protocol connection URL, not a payment page.


## Amount-based own-wallet credit purchase

仅在用户明确要求为本人钱包增加 credit 并指定金额时，才准备对应官方付款。ChatGPT 只提供中性的账号状态和原请求下一步。
用户明确要求为本人钱包增加 credit 并指定金额时，才执行原安装的 wallet --topup 金额；有原待续接请求时带 --request。
Every wallet link or payment card must identify the current account as 名字 · 末6位 from the authenticated account information. Browser and credited accounts are separate facts. Fixed SKUs are shortcuts, never amount limits.

When the user explicitly asks to buy credit without an amount, return the official wallet link without creating a payment or proposing an amount. For insufficient_balance, report the account state and keep the original request and its continuation link with the same hint. Never turn these cases into an unsolicited payment order.

Only when the user explicitly requests an increase in their own wallet credit and specifies the amount, run `itpay api wallet --topup 30 --json` (use the user's amount). If continuing a saved insufficient-balance task, add `--request <original request_id>`. OAuth and valid api_hub Keys can prepare their own wallet credit purchase without a spending grant. The server quotes positive CNY amounts in cents using the actual environment’s policy: production minimum ¥10; approved dev minimum ¥1. Send the user’s original positive amount and relay the returned minimum_applied/notice, actual payment and credit amounts. Do not hardcode or calculate the adjustment; for example, dev input 0.50 may return “最低支付 ¥1，本单支付 ¥1，获得 1 credit”. The reply and official card must identify the masked credited account, actual amount and expiry.

When browser capability is available, immediately open the returned official page_url. Provide the same checkout_url and, where supported, the returned official image. Scan and click are user choices. Limited display capability does not stop payment; a link-only host can use the same checkout. Do not draw or reconstruct QR codes. `--no-open` expresses a host without browser opening. Poll the returned original credit purchase status; when credited follow the returned original call --pending, never create another business request. A shared funding card does not transfer another connection's task.

Report low_balance once per notification_id with available_atoms, compared_price_atoms and the official wallet link. Key authorization/budget failures use the exact server-issued Key settings link, never a credit purchase to bypass a grant. Funding never enables API spending or merchant payment/refund permission.

Credit is the user-facing pricing unit: 1 credit = CNY 1. Preserve wire currency CNY, scale 6 and all amount_atoms fields exactly. USD payments use the frozen server exchange quote. Always distinguish fiat paid from credit received; never compute a replacement quote.

## Credit amounts and reporting

Balances, API quotes, holds and charges are in credit: **1 credit = ¥1 equivalent**. Quote users in credit first; when useful add “approximately ¥X”. Do not call an API balance cash or tell users to add money. With USD or another supported purchase currency, the server converts the actual fiat payment into credit using the frozen exchange rate at purchase time. Show fiat paid on the payment page and credit received on the receipt; never calculate a substitute FX quote.

When credit is insufficient, report the account state and preserve the returned original wallet/intent link and recovery command. Do not create a purchase or suggest an amount without explicit user intent. Preserve authorization, budget, request and idempotency identity. Purchasing credit never increases a spending grant. Machine fields `currency`, `scale`, `amount_atoms`, `captured_atoms` and `held_atoms` stay unchanged; CNY/scale 6 wire values represent the same credit equivalent, with 1,000,000 atoms per credit. Services tickets, merchant collections and cash refunds retain their actual fiat currency.

## Published package and candidate boundary

Release 0.2.75 includes the documented original-wallet refund and payer-currency flags. Read this installed package help and retain its original launcher/profile. minimum_cli and exact blocked_versions require an update; recommended_cli only advises. Missing capabilities affect only the requested new operation. Hash/revision differences alone do not block use. If an old environment has not been upgraded, use the official dev entry for new tasks, without moving an accepted or unknown request.

## Private My API / My Key

Manage private OpenAPI preparation at /me/apis and supplier My Key at /me/credentials using the normal signed-in website. This is not an extra public CLI upload command. /me/keys and itk_ are ItPay authentication keys, not supplier credentials. Private package specification: https://dev.itpay.ai/developers/my-api-package.txt . Own-key read-only generic HTTPS JSON supports header/query API Key or bearer; non-GET/HEAD operations require the owner's explicit read-only confirmation. Its Hub fee is 0 credit; supplier charges may still apply and native workflow prices are separate. Missing/revoked supplier keys require My Key correction with no platform fallback; original/unknown runs and receipts keep their identity. No unselected third-party supplier or all-host acceptance is implied.

Original-wallet refund flow requires explicit refund intent, saved original preview/request and normal OAuth: preview does not submit, confirmation uses that exact saved ID, and pending/unknown only reads its original status. Never invent refund amount/destination or replace an uncertain request. Read installed help for the exact supported interface.

For a new call, omit credential mode to use the account's applicable My Key (0 Hub credit); use `--credential-mode platform` only for explicitly consented platform supply and its shown price. An unavailable Key never silently falls back. If the original response hands off a Key choice, open its official URL and run `api status <original_request_id> --wait 120`. The account owner chooses credit, updates the Key or stops; the browser resumes via the original intent. Wait again on the same request while pending, without requiring a human reply. Unknown/reconciling only reads the original outcome. `--pending` cannot change the saved credential mode.

Device 单次额度不足时保留原请求，按正式 next 的 `api connect --request <原请求>` 在同一连接确认本次消费额度；授权后只读 `status --wait 120` 等原单。对已有执行、unknown/reconciling、普通404或无原scope证明的错误，不重新提交。历史明确准入前拒绝仅在服务端确认原scope未受理且同Device额度仍低于冻结平台报价时，按原next准备原intent；不改输入、价格、账号或请求ID。终态无必须继续步骤，仍可按需只读status。 服务端明确提供原请求的 failed-zero 关联证明时，保留旧失败收据，按原 next 等用户选择并接续原请求；不得自行换 Key、改用 credit 或新建替代请求。

To disconnect, open the normal owner page /agent/connections and revoke only the intended connection. Website sign-out alone is not OAuth revocation. A consumed confirmation URL is not a management page. Revoked/denied stops automatically; only an explicit request to sign in again uses the same launcher and installation with `agent --surface api --new-task --reconnect --wait 120 --json` (both flags are in `agent --help`). Do not delete profiles, change identity or reset an accepted request.
