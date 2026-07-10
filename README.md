# ItPay CLI

The V3 terminal and agent-facing CLI for ItPay commerce.

```bash
npm install -g @itpay/cli
itpay readyz
itpay docs show quickstart
```

The CLI defaults to the production API at `https://api.itpay.ai`. Set
`ITPAY_BACKEND_URL` only when intentionally using another backend.

## Commands

- `itpay readyz` — `GET /v1/readyz`
- `itpay next [--json]` — show the next recommended agent action from remembered server handles
- `itpay cart add --item <id> --variant <id> --offer <id> [--quantity 1] [--input <json>] [--host <host>] [--json]` — create/update the canonical server cart; service-backed lines return `service_execution_id`
- `itpay cart next [--json]` — show the next recommended action for the remembered canonical server cart
- `itpay cart add --local ...` — explicit local draft compatibility mode only, not valid for service-backed flows
- `itpay cart remove --line <cart_item_id>` — soft-remove an active line from the canonical server cart; quote-locked or checkout-bound lines are rejected
- `itpay cart remove --local --variant <id> --offer <id>` — drop a local draft line
- `itpay cart show` — print the canonical server cart, or local draft fallback when no server cart handle exists
- `itpay cart clear` — abandon the canonical server cart and clear local handles
- `itpay cart clear --local` — clear local handles/draft only
- `itpay buy --cart <cart_id> --host <host> [--target <target>] [--qr-format ...] [--qr-file <path>]` — create checkout from a canonical server cart and render the branded checkout QR for the host
- `itpay buy --host <host> [--target <target>] [--item ... --variant ... --offer ...] [--quantity 1]` — compatibility one-shot cart + checkout path
- `itpay services start <service_id>` — start a generic Service Execution run
- `itpay services invoke <service_execution_id> --capability <capability_id> --input key=value` — invoke an agent-visible capability
- `itpay services action <service_execution_id> --action <action_type> [--result-item <id>]` — record a human/agent service action
- `itpay services checkout <service_execution_id> --capability <capability_id> [--email <email>] [--host <host>] [--json]` — create quote lock from Service Execution state, require email only for capabilities that deliver a claim link, persist the handoff, and render the branded ItPay checkout
- `itpay services checkout <service_execution_id> --resume --json` — reissue a lost or expired handoff for the same unpaid checkout without asking for contact information again
- `itpay services next <service_execution_id> [--json]` — show the next recommended action from the Service Execution read model
- `itpay services get <service_execution_id>` / `itpay services events <service_execution_id>` — read the redacted Service Execution timeline
- `itpay checkout --id <checkout_id> --token <display_token>` — read canonical checkout presentation
- `itpay pay --checkout <id> --method alipay|wechatpay` — CLI escape hatch for operator/manual testing only; normal buyer flow opens the ItPay checkout page first
- `itpay order <order_id>` — read one V3 order
- `itpay orders [--limit 20] [--status <status>]` — list account-scoped orders (requires `ITPAY_BEARER_TOKEN`)
- `itpay refund --order <id> --payment-intent <id> --amount-minor <n> --currency <code>` — request a refund

## Hosts

The CLI dispatches to a per-host renderer based on `--host`:

| `--host` | Renderer | Native UI |
| --- | --- | --- |
| `terminal` | `render/terminal.ts` | terminal QR + summary |
| `codex`, `claude-code` | `render/markdown.ts` | markdown image + links |
| `telegram` | `render/telegram.ts` | openclaw `message send` with inline buttons |
| `feishu`, `lark` | `render/feishu.ts` | Feishu/Lark interactive card (url + callback) |
| `discord`, `whatsapp`, `plain-chat` | `render/plain_chat.ts` | text + links, no native buttons |

Aliases: `tg` and `openclaw-telegram` map to `telegram`; `feishu_im` and `fs` map to `feishu`.

## Environment

- `ITPAY_BACKEND_URL` — optional backend override (default `https://api.itpay.ai`)
- `ITPAY_BEARER_TOKEN` — account-scoped session token (only needed for `orders`)
- `ITPAY_AGENT_DEVICE_ID` — agent device id, used for cart/service execution quota identity and `client_context`
- `ITPAY_CURRENCY` — checkout currency (default `CNY`)
- `ITPAY_IDEMPOTENCY_KEY` — `Idempotency-Key` for pay/refund requests (auto-generated if unset)
- `ITPAY_IDE_IMAGE_ATTACH` — set to `0` to disable the IDE image-attach contract (e.g. read-only runner FS). Default `1`.
- `ITPAY_IDE_IMAGE_DIR_OVERRIDE` — override the canonical IDE image directory instead of `$TMPDIR/itpay-v3-qr`. Useful when the IDE file panel only knows one path.

## Agent next actions

Service-backed flows return progressive guidance for agents:

- `itpay cart add --json`, `itpay services start`, `itpay services invoke`,
  `itpay services action`, `itpay services get`, and
  `itpay services checkout --json` include top-level `next_actions`.
- `itpay next`, `itpay cart next`, and `itpay services next <id>` print only
  the next recommended command and recovery commands.
- The guidance is derived from server cart and Service Execution read models.
  Local `~/.itpay-v3/cart.json` only stores handles such as `cart_id`,
  `service_execution_id`, `checkout_id`, and `display_token`.

Agents should prefer `next_actions` over hardcoded service-specific flows.
For example, a service-backed cart add can return an invoke command for an
agent-visible free capability, while a quote-locked execution can return the
checkout handoff command.

## IDE image attach

Every `itpay buy`, `itpay services checkout` (and `itpay checkout`,
`itpay order`) downloads the
brand checkout QR from the backend and writes it to a stable local
file the agent can hand to the IDE image viewer (Trae `Read` tool,
Codex, Claude Code). The contract is:

- canonical file: `<os.tmpdir()>/itpay-v3-qr/itpay-v3-<kind>-<id>.png`
  (override with `ITPAY_IDE_IMAGE_DIR_OVERRIDE`)
- when `/tmp/itpay-v3-qr` is a separate, writable location it gets a
  mirror of the same file under the same name
- filename is stable per checkout, so re-runs overwrite the same
  local file rather than scattering copies across the scratch dir

Outputs that carry the IDE image attach:

- `itpay buy --json` — fields `brand_qr_local_path`, `brand_qr_mirrors`,
  `brand_qr_stable_name`, `brand_qr_status` (`downloaded` / `failed`
  / `disabled` / `fallback`), `brand_qr_error`, `brand_qr_data_url`,
  `brand_qr_must_render_reason`, `brand_qr_render_action`. Read the
  path with the IDE's `Read` tool so the human sees the picture.
- `itpay services checkout --json` — same brand QR fields, plus
  `next_action: "open_human_checkout"` and the checkout-scoped
  `display_token`. Agents must show this ItPay checkout QR/URL to the
  human and must not call `itpay pay` for the normal buyer flow.
- Markdown (Trae / Codex / Claude Code) — inlines a `data:image/png;base64,...`
  copy of the picture plus a `[ATTACH] IDE image` reference block that
  points at the canonical local path and mirrors.
- Terminal — prints `Branded QR: /path/...png` and `QR mirrors: ...`;
  iTerm inline image renders the same file when the session supports it.
- Telegram — the `ide_image_attach` block on `presentation.ide_image_attach`
  carries `status`, `local_path`, `mirrors`, `mime_type`, `source`,
  `caption`, `error` (when failed), `must_render_reason`, and a
  step-by-step `instructions` array.
- Feishu / Lark — same `ide_image_attach` block on the
  `message.ide_image_attach` envelope.

Disable the contract with `ITPAY_IDE_IMAGE_ATTACH=0` for runners on a
read-only filesystem. The plan carries `status: "disabled"` instead
of `status: "downloaded"` and no PNG is downloaded.

## Layout

- `src/main.ts` — `commander` entrypoint, command registration
- `src/client/` — HTTP/JSON client and DTOs
- `src/commands/` — one file per command family
- `src/render/` — terminal formatting
  - `plan.ts` — `RenderPlan` contract shared by all renderers
  - `qr.ts` — local QR + format selection
  - `terminal.ts`, `markdown.ts`, `plain_chat.ts`, `telegram.ts`, `feishu.ts` — per-host renderers
  - `index.ts` — `dispatchRender()` picks the right renderer
  - `sink.ts` — `OutputSink` so tests can silence stdout
- `src/state/` — local CLI config, cart session, client context
- `tests/` — node:test smoke test + in-process mock backend

## Rules

- commands orchestrate user intent only
- render code must not issue HTTP calls
- keep API access under `src/client/`
- persist checkout-scoped `display_token` and last server handles only in the owner-only local cart session file
- the default `buy` command must not create a payment intent unless `--pay` is explicit
- the default `services checkout` command must render the ItPay
  checkout handoff; provider payment intents are created by the human
  checkout page, not by the agent
- a renderer must consume the brand QR the V3 backend hands back
  (`qr_payload` / `qr_png_url` / `mobile_wallet_url`) and only
  self-generate a QR for `auth_qr` / `checkout_qr` with the explicit
  `--qr-file` opt-in
