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
|api wallet|Available/held money and official proactive top-up URL.|

All support --json. Installation uses setup --api-prefix. Connection uses api connect, connect continue, connect status and connect restart. Explicit rejection of refresh returns the original profile's connect --request command. Immediately follow the emitted waiting command. Successful reconnection returns status of the same original request, which can then return call --pending.

Show purpose, price and TTL before obtaining consent. A publication change requires reading the original receipt and showing the new price. A network-unknown write permits only original status reads. A failed call is called free of charge only when captured and held are both confirmed zero. Source result expiry does not remove fee facts.

The developer credentials import, admin and doctor commands are outside the six business commands. Services/cart/buy/checkout keep their separate authority and entry points.
