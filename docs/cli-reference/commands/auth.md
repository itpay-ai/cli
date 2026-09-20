# Account login

`itpay auth` binds the enrolled Agent Device to a real ItPay account through an official authorization handoff. It is used by Path A (trial exhausted → log in → keep querying) and any time a command returns `login_required`. Path B purchases do **not** require running `itpay auth login` first — account authentication can happen inside the protected checkout instead.

## Syntax

```bash
itpay auth login  [--json]
itpay auth status [--json]
```

Both commands require an enrolled Agent Device and use the current `--agent-type` and Backend (`ITPAY_BACKEND_URL`). The Agent never receives an account bearer token; binding reuses the stable device-account ownership mechanism.

## `itpay auth login`

Creates one official authorization request bound to this Backend, Device and Agent Instance, then stops. Repeating `auth login` while a valid request is open returns the same request — it does not rotate the QR code or create parallel sessions.

```json
{
  "status": "auth_pending",
  "result": {
    "dashboard_auth_session_id": "das_...",
    "expires_at": "2026-09-20T12:34:56Z",
    "methods": ["phone", "email", "alipay", "wechat"]
  },
  "handoff": {
    "url": "https://dev.itpay.ai/signin?dashboard_auth_session_id=das_...&start_token=...",
    "qr_local_path": "...",
    "qr_image_url": "...",
    "markdown": "..."
  },
  "instruction": "把官方授权页或二维码交给用户。用户在页面内选择手机号验证码、邮箱或钱包完成登录；不要替用户输入手机号或验证码。",
  "next": {
    "command": "itpay auth status --json",
    "reason": "用户完成页面登录后确认绑定",
    "poll_after_ms": 5000
  },
  "recovery": []
}
```

- `handoff.url` is the official sign-in page carrying this authorization request. The page offers phone-code verification, email verification, and wallet options — the user chooses; the Agent must not deep-link a single wallet and call it universal authorization.
- The URL's `start_token` is valid only inside the official page handoff. Never log it, echo it in chat, or send it to another host.
- When the user already finished login before `auth login` runs, the command returns `authenticated` directly.

## `itpay auth status`

Polls the open authorization request, then performs the device binding. Safe to run repeatedly and concurrently: only the requester Device/Instance can complete the binding.

```json
{
  "status": "auth_pending",
  "result": { "dashboard_auth_session_id": "das_...", "expires_at": "..." },
  "instruction": "用户仍在官方页面完成登录；保留当前 handoff，不要生成新二维码。",
  "next": { "command": "itpay auth status --json", "poll_after_ms": 5000 },
  "recovery": []
}
```

```json
{
  "status": "authenticated",
  "result": {
    "buyer_id": "buyer_...",
    "bound": true,
    "query_quota": [
      { "service_id": "itpay-rail-exact", "policy": "free_registered", "remaining": null },
      { "service_id": "itpay-rail-smart", "policy": "free_registered", "remaining": null }
    ]
  },
  "instruction": "登录与绑定已完成，告知用户可继续之前的查询；已注册账号查询不消耗试用次数，仍受正常限流。",
  "next": { "command": "itpay services run <service_id> --execution <pending_execution_id> --json", "reason": "恢复被额度暂停的原查询" },
  "recovery": []
}
```

Terminal and error states:

| `status` | Meaning | Agent action |
| --- | --- | --- |
| `authenticated` | Device bound to a real account | Resume the original intent (a quota-blocked execution, the user's request) unchanged |
| `auth_pending` | User has not finished the page | Keep the same handoff; poll with `poll_after_ms` |
| `auth_expired` | Session expired before completion | Offer to start `itpay auth login` again; prior query input is still preserved server-side |
| `login_required` | No open request, not bound | Run `itpay auth login` |
| `auth_cancelled` / `auth_denied` | User declined or closed the page | Respect the refusal; do not silently re-open; the pending query stays resumable |

## Rules

- The human's phone number and SMS code are entered only on the official page — never through chat or CLI input. A `buyer_id`, a typed phone string, or a passenger phone is **not** proof of phone verification.
- Verified email OR verified mainland phone both establish a valid login; the user picks on the page. Phone verification is not a prerequisite for registered free search — a verified email alone is sufficient.
- Login never grants Vault content, passenger history, or another Agent's authority. Other devices/platforms enroll and authorize separately.
- After `authenticated`, server-side identity is re-read; an anonymous execution blocked at the quota step resumes with `services run <service> --execution <id> --json` — no new execution, no re-asked itinerary.
- Refusing or cancelling login deletes nothing: saved results and purchase options remain usable.
- Seller authoring uses `itpay sell auth` separately.
