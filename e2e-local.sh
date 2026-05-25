#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
API_BASE=${VOLTAGENT_API_BASE:-http://localhost:3000}
NODE=${NODE:-$(command -v node)}

TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-e2e-home.XXXXXX")
TMP_SETUP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-setup-home.XXXXXX")
TMP_SETUP_NOWAIT_HOME=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-setup-nowait-home.XXXXXX")

cleanup() {
  rm -rf "$TMP_HOME" "$TMP_SETUP_HOME" "$TMP_SETUP_NOWAIT_HOME"
}
trap cleanup EXIT INT TERM

itp_home() {
  itp_home_dir="$1"
  shift
  attempt=0
  while :; do
    err_file="$itp_home_dir/itp-error.log"
    if out=$(HOME="$itp_home_dir" PATH=/nonexistent VOLTAGENT_API_BASE="$API_BASE" "$NODE" "$ROOT/bin/itp" "$@" 2>"$err_file"); then
      printf '%s' "$out"
      return 0
    fi
    status=$?
    error_text=$(cat "$err_file" 2>/dev/null || true)
    attempt=$((attempt + 1))
    if [ "$attempt" -lt 6 ] && printf '%s' "$error_text" | grep -q 'request failed: 429'; then
      sleep "$attempt"
      continue
    fi
    printf '%s\n' "$error_text" >&2
    return "$status"
  done
}

itp() {
  itp_home "$TMP_HOME" "$@"
}

json_get() {
  "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d); const path=process.argv[1].split('.'); let cur=v; for (const p of path) cur=cur?.[p]; if (cur === undefined || cur === null) process.exit(2); process.stdout.write(String(cur));})" "$1"
}

json_assert() {
  "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d); const fn = new Function('v', process.argv[1]); if (!fn(v)) process.exit(1);})" "$1"
}

printf 'checking server %s\n' "$API_BASE" >&2
curl -fsS "$API_BASE/api/status" >/dev/null
curl -fsS "$API_BASE/api/itp/plans" | json_assert "return v.success === true && v.data.plans.some(p => p.plan_id === 'coding-100')" >/dev/null

printf 'running one-command setup flow\n' >&2
SETUP=$(itp_home "$TMP_SETUP_HOME" setup --plan coding-100 --target codex --method fake --mock-approve --offline --json)
printf '%s' "$SETUP" | json_assert "return v.status === 'installed' && v.grant_id && v.base_url && v.openai_base_url && v.auth && v.auth.session_stored === true"
test -f "$TMP_SETUP_HOME/.codex/config.toml"
test -f "$TMP_SETUP_HOME/.itp/voltagent.env"

printf 'checking setup no-wait auth handoff\n' >&2
SETUP_NOWAIT=$(itp_home "$TMP_SETUP_NOWAIT_HOME" setup --plan coding-100 --target codex --method fake --no-wait --json)
printf '%s' "$SETUP_NOWAIT" | json_assert "return v.status === 'waiting_human_auth' && v.action === 'scan_alipay_auth' && v.auth_id && v.user_code && v.verification_uri_complete"

USERNAME="e2e-$(date +%Y%m%d%H%M%S)-$$"
printf 'registering %s\n' "$USERNAME" >&2
AUTH=$(itp auth register --runtime codex --mock-approve --alipay-user-id "2088$RANDOM$RANDOM" --json)
printf '%s' "$AUTH" | json_assert "return v.account_id && v.device_id && v.session_stored === true"

ACCOUNT=$(itp account show --json)
printf '%s' "$ACCOUNT" | json_assert "return v.password_set === false && v.account && v.account.account_id"

printf 'setting first password\n' >&2
printf 'secret123\n' | itp account set-password --password-stdin --json | json_assert "return v.password_set === true"
ACCOUNT=$(itp account show --json)
printf '%s' "$ACCOUNT" | json_assert "return v.password_set === true"

printf 'creating fake checkout\n' >&2
CHECKOUT=$(itp checkout create --plan coding-100 --method fake --idempotency-key "e2e-$USERNAME" --json)
CHECKOUT_ID=$(printf '%s' "$CHECKOUT" | json_get checkout_id)
GRANT_ID=$(printf '%s' "$CHECKOUT" | json_get grant_id)
printf '%s' "$CHECKOUT" | json_assert "return v.status === 'grant_issued' && v.grant_id && !v.payment.cashier_url"

printf 'waiting payment %s\n' "$CHECKOUT_ID" >&2
PAYMENT=$(itp payment wait "$CHECKOUT_ID" --timeout 10 --json)
printf '%s' "$PAYMENT" | json_assert "return v.status === 'grant_issued' && v.grant_id"

printf 'installing grant %s\n' "$GRANT_ID" >&2
INSTALL=$(itp grants install "$GRANT_ID" --target codex --json)
printf '%s' "$INSTALL" | json_assert "return v.grant_id && v.credential && v.credential.credential_store"

printf 'installing codex profile in temp HOME\n' >&2
itp install codex --grant "$GRANT_ID" --offline --no-test --json | json_assert "return v.target === 'codex' && v.grant_id"
test -f "$TMP_HOME/.codex/config.toml"
test -f "$TMP_HOME/.itp/voltagent.env"

BALANCE=$(itp balance --json)
printf '%s' "$BALANCE" | json_assert "return v.active_grants === 1 && v.credits_remaining === '100.000000'"

ORDERS=$(itp checkout list --limit 5 --json)
printf '%s' "$ORDERS" | json_assert "return Array.isArray(v.orders) && v.orders.some(o => o.checkout_id === '$CHECKOUT_ID')"

USAGE=$(itp usage --grant "$GRANT_ID" --json)
printf '%s' "$USAGE" | json_assert "return v.grant_id === '$GRANT_ID' && v.total && v.total.requests === 0"

printf 'rotating grant key\n' >&2
ROTATE=$(itp keys rotate --grant "$GRANT_ID" --json)
printf '%s' "$ROTATE" | json_assert "return v.grant_id === '$GRANT_ID' && v.credential && v.credential.credential_store"
TOKEN=$(itp token issue --grant "$GRANT_ID" --stdout)
case "$TOKEN" in
  sk-*) ;;
  *) echo "token issue did not return sk-* token" >&2; exit 1 ;;
esac

printf 'revoking grant\n' >&2
REVOKE=$(itp grants revoke "$GRANT_ID" --json)
printf '%s' "$REVOKE" | json_assert "return v.status === 'revoked'"
BALANCE=$(itp balance --json)
printf '%s' "$BALANCE" | json_assert "return v.active_grants === 0"

printf 'voltagent local e2e ok\n'
printf 'server: %s\n' "$API_BASE"
printf 'account: %s\n' "$(printf '%s' "$AUTH" | json_get account_id)"
printf 'checkout: %s\n' "$CHECKOUT_ID"
printf 'grant: %s\n' "$GRANT_ID"
printf 'temp_home_cleaned_on_exit: %s\n' "$TMP_HOME"
