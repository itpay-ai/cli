# `itpay setup`

Use the host's permitted persistent npm installation or a normal global install. Fix that exact executable for all commands; installation location does not change the device identity directory.

```sh
itpay setup --agent-type <actual_type> --json
```

Run once after installation or upgrade. Unsupported/missing type and unavailable same-package Skill fail before network access. This command reads authoritative device/account status using existing authentication; it does not install, launch login or run business commands.

`setup_ready` returns `cli_version`, `backend_url`, `agent_type`, `device_status: ready`, `account_status: authenticated|login_required`, absolute `skill_path` and package-bound `skill_version`. `next` is null. Read the original Skill and enable it using the host mechanism before business; setup does not claim either happened. Repeated setup preserves identity and existing authorization. Account unknown, missing endpoint or incompatible Backend fails with nonzero exit and the actual reason.

For testing set `ITPAY_BACKEND_URL=https://dev.itpay.ai` on every invocation; production defaults to app.itpay.ai. Do not switch environments to hide failure. `install`, `readyz` and `auth status` remain diagnostic/compatibility commands, not a required initialization chain.
