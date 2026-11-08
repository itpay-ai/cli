# API Hub CLI

Use the same installation launcher and absolute --profile selector for every call.

|Command|Behavior|
|---|---|
|api categories|Real categories, including empty shelves.|
|api list [--category <id/slug/label>] [--query <text>] [--limit <1..100>] [--cursor <cursor>]|The website's saleable products, filtered before pagination.|
|api show <operation_id>|Purpose, price, JSON example and result TTL. Saves this installation's displayed publication.|
|api call <operation_id> --input <JSON/@file/->|After consent, submit using the shown price and publication.|
|api call --pending <request_id>|Read and, when eligible, continue this installation's original request. Each wait round is at most 120 seconds.|
|api status <request_id>|Read-only original receipt, result and charge.|
|api wallet|Account available/held money, selected credential kind/masked account and official proactive top-up URL.|
|api wallet --usage|Current Key/Consumer gross/net/refunded/held usage; runs include failures.|
|api wallet --transactions|Scoped charge/refund rows with limit/truncation; owner_billing_url opens full account history.|

All support --json. Installation uses setup --api-prefix. Connection uses api connect, connect continue, connect status and connect restart. Explicit rejection of refresh returns the original profile's connect --request command. Immediately follow the emitted waiting command. Successful reconnection returns status of the same original request, which can then return call --pending.

Show purpose, price and TTL before obtaining consent. A publication change requires reading the original receipt and showing the new price. A network-unknown write permits only original status reads. A failed call is called free of charge only when captured and held are both confirmed zero. Source result expiry does not remove fee facts.

The developer credentials import, admin and doctor commands are outside the six business commands. Services/cart/buy/checkout keep their separate authority and entry points.

A `price_changed` receipt includes `current_price` (CNY, scale 6, atoms) and verified original captured/held facts. When both are zero, the next command is show; explicit new-price consent is required before a new call. The ended original remains readable with status and has no stale funding handoff.

### API Key

Use a secret manager to inject ITPAY_HUB_KEY or pipe a private secret source to `itpay api credentials import --json`. Never pass the secret in argv or chat. With --profile, import into that same installation; an explicit environment Key remains selected. It does not need OAuth. Saved OAuth and Key remain private; the last explicit import/connect selects the credential, while a Key environment override selects that Key. Supplying both environment bearer and Key is an error. Requests remain isolated by original credential; neither a new Key nor OAuth can take over old requests.

Check `wallet` identity.account_hint and credential_kind; matching hints identify the same wallet, not the same consumer. Invalid/revoked Key or insufficient Key scope points to the official /me/keys page, without OAuth fallback. Hub MCP accepts Key only through its existing X-ItPay-Key protocol header; normal ChatGPT MCP uses OAuth. Do not paste a Key into chat or put it in a Bearer field. Services identity is independent.
