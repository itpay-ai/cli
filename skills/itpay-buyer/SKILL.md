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
services, choose an option, add the selected variant to cart, create checkout,
show first-purchase account authorization when required, show the returned
payment QR, wait for verified payment, and report redacted secure delivery
status.

This skill is intentionally short. Do not try to memorize the entire ItPay
protocol from this file. Use the CLI docs graph whenever you need details.

## Start Here

Run these commands before buying:

```bash
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
-> search catalog
-> explain/recommend a variant
-> collect required service input and buyer delivery email
-> create cart with selected UCP Variant.id
-> create checkout from cart_id
-> if auth_qr is returned, show it for Alipay login/registration consent
-> poll/resume checkout until payment_intent_id appears
-> show returned payment QR exactly
-> wait for payment_intent.verified
-> check redacted delivery status
-> tell the human to check email / ItPay secure claim UI
```

The high-level command can wrap this flow:

```bash
itp buy <variant_id> --sandbox --email <buyer_email> --phone <buyer_phone> --json
```

For step-by-step testing:

```bash
itp buyer catalog search --query "<user request>" --json
itp buyer catalog search --query "企业工商信息 查询" --category business_data_api --provider itpay_enterprise_data --service-type ai_api --json
itp buyer catalog get --variant <variant_id> --json
itp buyer cart create --variant <variant_id> --json
itp buyer cart create --variants <variant_id_1>,<variant_id_2> --quantities 1,1 --json
itp buyer cart show <cart_id> --json
itp buyer cart add <cart_id> --variant <variant_id> --quantity 1 --json
itp buyer cart remove <cart_id> --line <cart_line_item_id> --json
itp buyer checkout create --cart <cart_id> --email <buyer_email> --phone <buyer_phone> --json
itp buyer checkout resume <checkout_id> --json
itp buyer payment wait <payment_intent_id> --json
itp buyer checkout status <checkout_id> --json
```

For API products, read the product metadata input schema before cart creation.
Enterprise data products require query input at cart time:

```bash
itp buyer cart create --variant var_itpay_enterprise_fuzzy_search_cny01 --input company_name=京东 --json
itp buyer cart create --variant var_itpay_enterprise_precise_lookup_cny05 --input company_name_or_credit_no=北京京东世纪贸易有限公司 --json
itp buy var_itpay_enterprise_fuzzy_search_cny01 --sandbox --email <buyer_email> --input company_name=京东 --json
```

Use fuzzy search when the user gives a short name, brand, keyword, or uncertain
entity. Use precise lookup only after you have the exact China mainland
registered company name or unified social credit code. If the user says
"京东" or "那个京东商城", do not buy precise lookup until you resolve the exact
registered name or run fuzzy search first.

## Non-Negotiable Rules

1. Use `--json` for every ItPay command.
2. Do not invent service IDs, variant IDs, checkout IDs, payment URLs, QR URLs,
   payment intent IDs, delivery IDs, or claim links.
3. When the user asks for several compatible services, create one cart with
   `--variants` and one checkout. Split only when ItPay rejects the cart or
   explicitly says split checkout is required.
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
11. Prefer resume/wait over creating duplicate checkouts.
12. Do not create a cart for an API service until all required service input
    fields are known. For enterprise fuzzy search, `company_name` can be a
    broad keyword. For enterprise precise lookup, `company_name_or_credit_no`
    must be exact; otherwise warn the user that the query may waste the paid
    lookup.

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
itp docs show recovery --role buyer --json
itp docs show safety-policy --role buyer --json
```

Each docs page includes `next_docs`. Follow those links as the state changes.

For payment creation in an agent/chat client, prefer:

```bash
itp buy <variant_id> --sandbox --email <buyer_email> --phone <buyer_phone> --display agent --json
```

This keeps JSON output machine-readable while allowing the CLI to prepare a
local QR image path for clients that cannot render remote SVG reliably. If the
human is on mobile, present `mobile_wallet_url` as a clickable human-only
fallback; do not convert it into a QR.

For first-purchase auth, treat the returned ItPay authorization entry as a
single human orchestration entry. It may open Alipay login/registration first
and then payment after ItPay receives the OAuth callback. Do not call
`oauth_start_url` directly unless the ItPay auth page asks for fallback.
If the payment page says the Alipay sandbox entry is stabilizing/preparing,
or if Alipay sandbox says "order not found", tell the human to wait 30-60
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
Please scan the returned ItPay-hosted QR image with Alipay sandbox.
I am waiting for ItPay payment verification.
Payment is verified.
Delivery is claimable by the human buyer. Please check your email.
```

Do not include raw protected content in the message.
