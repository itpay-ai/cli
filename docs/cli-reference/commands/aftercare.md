# `itpay aftercare`

Railway manual refund/change intake; ordinary service refunds retain `itpay refund`.

```sh
itpay aftercare list --order <order_id> --json
itpay aftercare create --order <order_id> --input-json <file> --json
itpay aftercare get <case_id> --json
itpay aftercare respond <case_id> --input-json <file> --json
itpay aftercare cancel <case_id> --input-json <file> --json
```

`list` returns the complete current JSON templates, original safe journey and available ticket targets. Indices start at zero. Use user-selected targets; do not guess supplier IDs or money. Only real scope consent sets `user_confirmed_scope=true`.

`get` shows original immutable request, history, supplier facts and separate money state. Pending/manual intake does not authorize financial execution. A current change proposal must be explicitly accepted using its returned revision; the original purchase consent is insufficient. Fees are coordinated manually, with no automatic payment link. Cancellation cannot undo supplier or money operations already started. Platform content locks remain; safe remaining-ticket status is a separate authorized read.
