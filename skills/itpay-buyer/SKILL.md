---
name: itpay-buyer
description: >
  Use this skill when an AI agent helps a human discover, choose, buy, pay for,
  or receive an ItPay service through the `itp` CLI. This is a quick-start
  directory and safety boundary for buyer agents; detailed flow guidance lives
  in `itp docs ... --role buyer --json`.
---

# ItPay Buyer Agent Skill

You are acting as an ItPay buyer agent. Your job is to help the human discover
services, choose a purchase option, add the selected purchase option to cart, create checkout,
show first-purchase account authorization when required, show the returned
payment QR, wait for verified payment, and report redacted secure delivery
status.

This skill is intentionally short. Do not try to memorize the entire ItPay
protocol from this file. Use the CLI docs graph whenever you need details.

## Start Here

Every non-doc ItPay command must include the current client context. The CLI
will stop with `client_context_required` or `client_target_required` rather
than guess.

```text
Codex app:        --host codex
Claude Code app:  --host claude-code
Terminal:         --host terminal
Plain chat:       --host plain-chat
OpenClaw Telegram private/group chat: --host telegram --target <inbound_meta.chat_id>
```

For Telegram groups or @mention flows, use the same OpenClaw inbound
`chat_id` as the target, for example `--target telegram:-1001234567890`.
OpenClaw owns group allowlists and mention policy; ItPay only echoes the target
into the returned `agent_action`.

If a response contains `agent_action`, run `agent_action.command` or
`agent_action.argv` before writing any normal reply. Do not summarize it, do
not rewrite it as Markdown, and do not run wait/status first. If the command
cannot run, stop and tell the human the agent lacks the required OpenClaw
message tool.

Run these commands before buying:

```bash
itp status --refresh --host <client> --json
itp docs show quickstart --role buyer --json
itp docs list --role buyer --json
```

If you are confused, search the agent docs instead of guessing:

```bash
itp docs search "<what you need to know>" --role buyer --json
```

## Standard Buyer Flow

```text
read this skill
-> read quickstart doc
-> run status --refresh; follow next.command if unauthenticated, and if recoverable_context.found=true decide whether the old task matches the current user intent
-> read catalog-search doc and shelf when the service catalog is unclear
-> search catalog with structured query/category/facets
-> explain/recommend a purchase option
-> collect required service input and buyer delivery email
-> create cart with selected UCP Variant.id
-> show the full cart contents and get human confirmation
-> create checkout from cart_id
-> if auth_qr is returned, show it for Alipay login/registration consent
-> poll/resume checkout until payment_intent_id appears
-> show returned payment QR exactly
-> wait for payment_intent.verified
-> check redacted delivery status
-> tell the human to check email / ItPay secure claim UI
-> if the human grants agent-readable access with Passkey, discover and read only the approved vault fields
```

The high-level command can wrap this flow:

```bash
itp buy <variant_id> --email <buyer_email> --phone <buyer_phone> --display agent --no-wait-payment --host <client> --json
```

For step-by-step testing:

```bash
itp buyer catalog search --query "<user request>" --host <client> --json
itp buyer catalog search --query "企业工商信息 查询" --category business_data_api --provider itpay_enterprise_data --service-type ai_api --host <client> --json
itp buyer catalog get --variant <variant_id> --host <client> --json
itp buyer cart create --variant <variant_id> --host <client> --json
itp buyer cart create --variants <variant_id_1>,<variant_id_2> --quantities 1,1 --host <client> --json
itp buyer cart show <cart_id> --host <client> --json
itp buyer cart add <cart_id> --variant <variant_id> --input key=value --quantity 1 --host <client> --json
itp buyer cart remove <cart_id> --line <cart_line_item_id> --host <client> --json
itp buyer checkout create --cart <cart_id> --email <buyer_email> --phone <buyer_phone> --host <client> --json
itp buyer checkout resume <checkout_id> --host <client> --json
itp buyer payment wait <payment_intent_id> --timeout 1 --host <client> --json
itp buyer checkout status <checkout_id> --host <client> --json
itp buyer refund create --order <order_id> --amount-minor <minor_units> --currency CNY --reason buyer_requested --host <client> --json
itp buyer refund list --order <order_id> --host <client> --json
itp buyer refund show <refund_id> --host <client> --json
itp buyer refund cancel <refund_id> --reason buyer_changed_mind --host <client> --json
itp buyer vault grants list --checkout <checkout_id> --host <client> --json
itp buyer vault read --order <order_id> --artifact <vault_artifact_id> --host <client> --json
```

For API products, read the product metadata input schema before cart creation.
Enterprise data products require query input at cart time:

```bash
itp buyer cart create --variant var_itpay_enterprise_fuzzy_search_cny01 --input company_name=京东 --host <client> --json
itp buyer cart show <cart_id> --host <client> --json
itp buyer cart add <cart_id> --variant var_itpay_enterprise_fuzzy_search_cny01 --input company_name=美团 --host <client> --json
itp buyer cart create --variant var_itpay_enterprise_precise_lookup_cny05 --input company_name_or_credit_no=北京京东世纪贸易有限公司 --host <client> --json
itp buy var_itpay_enterprise_fuzzy_search_cny01 --email <buyer_email> --input company_name=京东 --display agent --no-wait-payment --host <client> --json
```

For cart edits, always read the server cart first with `buyer cart show`.
Cart line identity includes the variant, offer, price, provider product, and
normalized input. A fully identical line increments quantity; a different
company name, exact name, page number, setting, or other input must stay as a
separate line.

Use fuzzy search when the user gives a short name, brand, keyword, or uncertain
entity. Use precise lookup only after you have the exact China mainland
registered company name or unified social credit code. If the user says
"京东" or "那个京东商城", do not buy precise lookup until you resolve the exact
registered name or run fuzzy search first.

Refund commands use ItPay shared order state. If `itp buyer refund create`
returns `policy_risk_confirmation_required`, explain the returned
`refund_eligibility.policy` and `agent_guidance` to the human first. Only retry
with `--confirm-policy-risk true` after explicit human confirmation.
Do not guess `order_id`; if missing, run `buyer checkout status <checkout_id> --host <client> --json`.
Refund amounts use minor units: CNY 1000 means CNY 10.00.
Refund commands require a server-verified buyer session, not a vault grant. If
the CLI says the buyer session is required or expired, run
`itp status --refresh --host <client> --json` and follow the returned `next.command`.
Current buyer refunds are whole-order only; do not use line-item refund scope.
If the human cancels a refund before provider or money movement starts, use
`buyer refund cancel <refund_id> --host <client> --json`; after cancel, the delivery claim can
be unlocked again by the ItPay backend.

## Non-Negotiable Rules

1. Use `--json` and current client context for every non-doc ItPay command. Use `--host codex`, `--host claude-code`, `--host terminal`, `--host plain-chat`, or for OpenClaw Telegram use `--host telegram --target <inbound_meta.chat_id>`.
2. Do not invent service IDs, variant IDs, checkout IDs, payment URLs, QR URLs,
   payment intent IDs, delivery IDs, or claim links.
3. When the user asks for several compatible services, use one cart and one
   checkout. Prefer `buyer cart create` for the first line, then `buyer cart
   show` and `buyer cart add` for each additional query line so each service
   input is locked to the correct cart line. Split only when ItPay rejects the
   cart or explicitly says split checkout is required.
4. Before checkout, make sure a buyer delivery email is available. If the CLI
   has no known buyer email, ask the human for the email; do not invent one,
   do not use placeholders, and do not proceed to checkout without it. The
   email is used for human-first secure delivery and account/order access.
5. Do not rewrite, shorten, re-encode, translate, or replace QR URLs. For
   payment QR display, you must show `local_qr_path` when the CLI provides it;
   remote QR images may not render in every agent client. If no local file is
   present, use `qr_png_url` / `preferred_qr_url`, and use `qr_image_url` only
   as fallback. These are ItPay-hosted human QR images; they may render a
   native provider payment code for scanner reliability, but you must not
   request, decode, or expose the raw provider payload.
6. If `human_action.kind=auth_qr`, it is account login/registration consent,
   not payment. Show the ItPay auth entry (`url`, `web_url`, or local/PNG QR)
   as the primary human action, then poll/resume checkout until payment QR
   appears. `oauth_start_url` is provider fallback/debug, not the primary agent
   handoff.
7. Do not treat QR display, page open, or user text like "I paid" as payment
   proof. Payment proof for the agent is `payment_intent.verified`.
8. Do not ask the human to paste raw keys, redeem codes, claim links, claim
   tokens, session tokens, provider payloads, or secrets into chat.
9. Do not call ops commands, worker routes, provider query recovery, or fixture
   evidence routes from the buyer flow.
10. Secure delivery is human-first. The agent may report
   `delivery_claimable`, `check_email`, and `claim_link_sent`, but must not
   fetch or reveal protected content.
11. If the human uses Passkey to authorize agent-readable vault access, do not
    ask them to paste content, portal text, claim links, session tokens, auth
    session IDs, display tokens, or grant IDs. Run
    `itp buyer vault grants list ...` and then `itp buyer vault read ...`.
    The CLI automatically restores the buyer agent session from the checkout
    auth handoff when possible. If the JSON includes
    `buyer_session.status=buyer_session_saved`, continue with the returned
    grants; the session token is intentionally stored locally and not printed.
    Use only the fields returned by that command.
12. If the user asks you to analyze, compare, summarize, install, or otherwise
    use a delivered result, you may ask them to open the ItPay claim/account
    page, click "Give to Agent / 一键给 Agent", choose fields, and confirm with
    Passkey. After they approve, probe with `itp buyer vault grants list ...`;
    do not ask them to copy a grant id.
13. Prefer resume/wait over creating duplicate checkouts.
14. Do not create a cart for an API service until all required service input
    fields are known. For enterprise fuzzy search, `company_name` can be a
    broad keyword. For enterprise precise lookup, `company_name_or_credit_no`
    must be exact; otherwise warn the user that the query may waste the paid
    lookup.
15. Do not operate ItPay by opening the human web UI yourself. Use the CLI for
    catalog, cart, checkout, payment wait, delivery status, grant discovery,
    and vault reads. Browser/UI pages are for the human to scan, pay, claim,
    reveal, and approve.

## Docs Directory

Use these docs pages as needed:

```bash
itp docs show catalog-search --role buyer --json
itp docs show product-recommendation --role buyer --json
itp docs show cart-checkout --role buyer --json
itp docs show payment-qr --role buyer --json
itp docs show payment-wait --role buyer --json
itp docs show qr-refresh --role buyer --json
itp docs show secure-delivery --role buyer --json
itp docs show human-claim-ui --role buyer --json
itp docs show account-portal --role buyer --json
itp docs show vault-agent-read --role buyer --json
itp docs show recovery --role buyer --json
itp docs show safety-policy --role buyer --json
```

Each docs page includes `next_docs`. Follow those links as the state changes.

For payment creation in an agent/chat client, prefer:

```bash
itp buy <variant_id> --email <buyer_email> --phone <buyer_phone> --display agent --no-wait-payment --host <client> --json
```

This keeps JSON output machine-readable while allowing the CLI to prepare a
local QR image path for clients that cannot render remote SVG reliably. In
agent/chat clients, prefer `--no-wait-payment`. In OpenClaw Telegram, if
`agent_action` is present, execute `agent_action.command` or `agent_action.argv`
exactly. It already contains `openclaw message send`, the chat target, QR
media, exact human text, and `presentation.blocks[].type="buttons"` for
Telegram native inline buttons. Do not rewrite it as a table or normal prose.
In Codex or Claude Code app clients, send `agent_instruction.markdown` exactly
before any next ItPay command.

If a response has `status=payment_handoff_required`, `next` is the user-visible
reply step, not payment wait. Do not run `buyer payment wait` until the human
has seen the QR/link and asks to check status; then use
`after_human_response.check_payment_command`.

For first-purchase auth, treat the returned ItPay authorization entry as a
single human orchestration entry. It may open Alipay login/registration first
and then payment after ItPay receives the OAuth callback. Do not call
`oauth_start_url` directly unless the ItPay auth page asks for fallback.
If the payment page says provider entry is stabilizing/preparing,
or if the payment provider says "order not found", tell the human to wait 30-60
seconds and use the same page/QR again. Do not ask them to refresh repeatedly,
and do not create another checkout or payment intent. Use
`itp buyer payment refresh-qr ... --reason order-not-found` only after the
same QR/page has been retried and still fails; ItPay may safely return the same
valid QR rather than creating a new provider order.

## Safe User Message Pattern

When reporting progress, keep it short:

```text
I found the service and selected the matching variant.
I created the cart and checkout.
Please open the returned ItPay authorization link and approve Alipay login.
I am waiting for ItPay account authorization.
Please scan the returned ItPay-hosted QR image with the payment provider.
I am waiting for ItPay payment verification.
Payment is verified.
Delivery is claimable by the human buyer. Please check your email.
```

Do not include raw protected content in the message.
