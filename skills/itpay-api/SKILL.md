---
name: itpay-api
description: Browse the shared API market, call a shown product with consent, and read the original request and wallet.
---

# ItPay API

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

status <request_id> only reads the original result, receipt and charge. An unknown state remains unknown until the owner reports facts. A result whose body has expired still has its fee receipt. Never create a new call, recharge or claim failure from a missing result or a network timeout.

call --pending <request_id> is the returned continuation form for this installation's original request. It preserves the stored operation, input, publication and idempotency key. It first reads the original request, reads an existing run, and only continues an eligible original intent. It waits in rounds of at most 120 seconds. Follow its next command while the human completes the original official action. A terminal result or null next ends waiting. Do not invent a continuation for an unknown write.

If refresh is explicitly rejected, follow the returned connect --request command for the same profile. Immediately run the returned connect continue waiting command while the human approves the original official link. Keep -- before an opaque handle. Wrong-account approval stops. Once credentials are freshly verified and saved, the next command is status of the original request. Follow its call --pending only when continuation is actually required. Network-unknown refresh preserves the original state and does not authorize another login or business request.

## Wallet and payment

wallet reads available and held atoms and provides the official proactive top-up URL. Wallet balance is shared account money, not this consumer's authorization cap. Insufficient balance uses the original intent's official top-up page and original call --pending wait command. Funding never increases an explicit spending cap.

Only open a top-up when the user authorized funding. N6.2 acceptance uses fakepass-platform-2, simulated, CNY and the advertised minimum ¥10 SKU. A page or callback does not prove wallet credit. Read the original server request and final charge. Do not create another payment or replacement intent.

Present only returned official links and branded cards or their official rendered images. Never reconstruct, crop or encode a payment QR, request credentials in chat, or expose tokens or private request bodies.

New task-driven installations use one official Agent connection page. Each business credential is prepared only when needed; API access does not require Services setup. Existing profiles keep their original authorization path. A denied or revoked connection stops; only an explicit user request permits `agent --reconnect` for the same Agent/account. Account connection never increases a transaction price, spending cap or budget.
