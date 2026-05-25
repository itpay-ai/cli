#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-home.XXXXXX")
TMP_PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-prefix.XXXXXX")

cleanup() {
  rm -rf "$TMP_HOME" "$TMP_PREFIX"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP_HOME/.itp"
cat >"$TMP_HOME/.itp/credentials.json" <<'JSON'
{
  "grant_gr_test": {
    "key": "sk-test",
    "grant_id": "gr_test",
    "target": "codex",
    "credential_store": "file",
    "credential_warning": "native credential store unavailable",
    "base_url": "http://localhost:3000",
    "openai_base_url": "http://localhost:3000/openai/v1",
    "anthropic_base_url": "http://localhost:3000/anthropic/v1",
    "gemini_base_url": "http://localhost:3000/gemini/v1beta",
    "models": ["gpt-5.5"],
    "install_profiles": ["claude-code", "codex", "openclaw"]
  },
  "grant_gr_missing_key": {
    "grant_id": "gr_missing_key",
    "target": "codex",
    "credential_store": "macos-keychain",
    "credential_ref": "voltagent:gr_missing_key",
    "base_url": "http://localhost:3000",
    "openai_base_url": "http://localhost:3000/openai/v1",
    "anthropic_base_url": "http://localhost:3000/anthropic/v1",
    "gemini_base_url": "http://localhost:3000/gemini/v1beta",
    "models": ["gpt-5.5"],
    "install_profiles": ["claude-code", "codex", "openclaw"]
  }
}
JSON
chmod 644 "$TMP_HOME/.itp/credentials.json"

node --check "$ROOT/bin/itp"
ITP_PREFIX="$TMP_PREFIX" "$ROOT/install.sh" >/dev/null
SKILL_PATH=$(HOME="$TMP_HOME" "$ROOT/bin/itp" skill path)
test -f "$SKILL_PATH"
HOME="$TMP_HOME" "$ROOT/bin/itp" skill show | grep -q "VoltaGent / ITPay Agent Runbook"
SKILL_JSON=$(HOME="$TMP_HOME" "$ROOT/bin/itp" skill show --json)
printf '%s' "$SKILL_JSON" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.skill !== "voltagent" || !json.path || !json.content.includes("Non-Negotiable Rules")) process.exit(1);})'
INSTALLED_SKILL_PATH=$(HOME="$TMP_HOME" "$TMP_PREFIX/bin/itp" skill path)
test -f "$INSTALLED_SKILL_PATH"
HOME="$TMP_HOME" "$TMP_PREFIX/bin/itp" skill show | grep -q "VoltaGent / ITPay Agent Runbook"
HOME="$TMP_HOME" "$ROOT/bin/itp" --help >/dev/null
HELP=$(HOME="$TMP_HOME" "$ROOT/bin/itp" --help)
printf '%s' "$HELP" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (!json.commands.includes("keys rotate --grant <grant_id>") || !json.commands.includes("checkout create --plan coding-100 --idempotency-key <uuid>") || !json.commands.includes("checkout list --limit 20") || !json.commands.includes("setup --plan coding-100 --target codex --method alipay") || !json.commands.includes("skill show")) process.exit(1);})'
AUTH_STATUS=$(HOME="$TMP_HOME" "$ROOT/bin/itp" auth status --json)
printf '%s' "$AUTH_STATUS" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.authenticated !== false) process.exit(1);})'
BALANCE_NO_SESSION=$(HOME="$TMP_HOME" "$ROOT/bin/itp" balance --json 2>/dev/null || true)
if [ -n "$BALANCE_NO_SESSION" ]; then
  echo "balance accepted without session" >&2
  exit 1
fi
PLANS_ALIAS=$(HOME="$TMP_HOME" "$ROOT/bin/itp" plans --json)
printf '%s' "$PLANS_ALIAS" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (!Array.isArray(json.plans)) process.exit(1);})'
HOME="$TMP_HOME" "$ROOT/bin/itp" install codex --grant gr_test --dry-run --json >/dev/null
HOME="$TMP_HOME" "$ROOT/bin/itp" install claude-code --grant gr_test --dry-run --json >/dev/null
HOME="$TMP_HOME" "$ROOT/bin/itp" install openclaw --grant gr_test --dry-run --json >/dev/null
HOME="$TMP_HOME" "$ROOT/bin/itp" install codex --grant gr_test --offline --no-test --json >/dev/null
HOME="$TMP_HOME" "$ROOT/bin/itp" doctor --target codex --json >/dev/null
DOCTOR=$(HOME="$TMP_HOME" "$ROOT/bin/itp" doctor --target codex --grant gr_test --offline --json)
printf '%s' "$DOCTOR" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.grant_credential_store !== "file" || !json.warning) process.exit(1);})'
TOKEN=$(HOME="$TMP_HOME" "$ROOT/bin/itp" token issue --grant gr_test --stdout)

if [ "$TOKEN" != "sk-test" ]; then
  echo "unexpected token output" >&2
  exit 1
fi

if HOME="$TMP_HOME" "$ROOT/bin/itp" install codex --grant gr_missing_key --dry-run --json >/dev/null 2>&1; then
  echo "install accepted missing grant credential key" >&2
  exit 1
fi

if HOME="$TMP_HOME" "$ROOT/bin/itp" account set-password --json >/dev/null 2>&1; then
  echo "set-password accepted without --password-stdin" >&2
  exit 1
fi

if printf '' | HOME="$TMP_HOME" "$ROOT/bin/itp" auth login --username smoke --password-stdin --json >/dev/null 2>&1; then
  echo "auth login accepted empty stdin password" >&2
  exit 1
fi

if HOME="$TMP_HOME" "$ROOT/bin/itp" auth login --username smoke --password badsecret --json >/dev/null 2>&1; then
  echo "auth login accepted --password" >&2
  exit 1
fi

echo "itp smoke ok"
