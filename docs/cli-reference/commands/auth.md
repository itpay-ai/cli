# Account login

Use `itpay auth login --json` to enroll the current Agent and open the official ItPay Web login. After the user finishes login and email verification, run `itpay auth status --json` to bind this enrolled Agent to the account. Keep declaring the actual `--agent-type` on both commands.

For dev, keep `ITPAY_BACKEND_URL=https://dev.itpay.ai` on every command. Login state and device registration are isolated from production.

Railway exact and smart query services each allow two anonymous queries after enrollment. After login, queries remain free within the published per-minute limits. On `login_required`, finish login and start a new query. On `rate_limited`, wait until the next minute; do not clear device state or retry in a loop.

The Agent receives no general account bearer token. This binding reuses the existing stable device-account ownership mechanism; switching account owners is not supported. Seller authoring continues to use `itpay sell auth` separately.
