# Task-driven Agent entry

For a new task use `itpay agent --surface api|services --task @/absolute/private-task.txt --json`. It selects this actual host's independent profile, saves the original task, prepares only the requested path, emits its official authorization link and waits up to120s. The Agent supplies its own --agent-type when runtime signals are absent; the person does not choose a type. For buffered tool output add --buffered, show the returned link and immediately execute next. Pending is not connected. Resume after any next reply with agent and no task; explicit new intent uses --new-task, retaining prior receipts. Existing accepted requests keep their original profile/commands; never copy them into a new host profile. Read the returned connected original task and same-package Skill; original API requests go to status first.

This entry is available in the development candidate from https://dev.itpay.ai/agent, not implicitly the fixed/npm package. First-batch Services and Hub remain independently authorized. Legacy setup below remains a diagnostic/compatibility path.

# `itpay setup`

Use the host's permitted persistent npm installation or a normal global install. Fix that exact executable for all commands; installation location does not change the device identity directory.

```sh
itpay setup --agent-type <actual_type> --json
```

Run once after installation or upgrade. Unsupported/missing type and unavailable same-package Skill fail before network access. This command reads authoritative device/account status using existing authentication; it does not install, launch login or run business commands.

`setup_ready` returns `cli_version`, `backend_url`, `agent_type`, `device_status: ready`, `account_status: authenticated|login_required`, absolute `skill_path` and package-bound `skill_version`. `next` is null. `skill_path` remains the Services path for compatibility. Select by deliverable: API/data/developer tasks read `itpay skill show itpay-api --json`; service handling, delivery and aftercare read `itpay skill show itpay --json`. Services account status does not verify Hub authorization. Read the needed original Skill and enable it using the host mechanism before business; setup does not claim either happened. Repeated setup preserves identity and existing authorization. Account unknown, missing endpoint or incompatible Backend fails with nonzero exit and the actual reason.

For testing set `ITPAY_BACKEND_URL=https://dev.itpay.ai` on every invocation; production defaults to app.itpay.ai. Do not switch environments to hide failure. `install`, `readyz` and `auth status` remain diagnostic/compatibility commands, not a required initialization chain.

Reuse the existing launcher and permitted state directory across chats; a new chat is not a new identity. A genuinely separate identity requires explicit authorization. New tasks prefer the permitted, available official CLI; otherwise use the corresponding hosted MCP. Do not require cloud hosts to attempt installation. Accepted, payment-pending and unknown tasks preserve their original entry and references.

API installations use `itpay setup --api-prefix <absolute-directory> --json`.
The returned private selector is supplied to `itpay api --profile <selector>`;
its dedicated launcher selects it automatically. This does not create API authority.

Agent options: `--task <text|@file>` saves the original request; `--surface api|services` selects its owner; `--request <id>` refers only to a local request in this same selected profile; `--wait <0..120>` bounds a wait round; `--buffered` returns the link before a separate wait call; `--new-task` records a genuinely new intent while preserving prior receipts; `--json` emits progress frames; `--help` describes this entry. Resume with no `--task` to keep the saved original.
