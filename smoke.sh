#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-home.XXXXXX")
TMP_PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/voltagent-itp-prefix.XXXXXX")
MOCK_SERVER_PID=""

cleanup() {
  if [ -n "$MOCK_SERVER_PID" ]; then
    kill "$MOCK_SERVER_PID" >/dev/null 2>&1 || true
  fi
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
SKILL_PATH=$(HOME="$TMP_HOME" "$ROOT/bin/itp" skill path --role buyer)
test -f "$SKILL_PATH"
HOME="$TMP_HOME" "$ROOT/bin/itp" skill show --role buyer | grep -q "ItPay Buyer Agent Skill"
SKILL_JSON=$(HOME="$TMP_HOME" "$ROOT/bin/itp" skill show --role buyer --json)
printf '%s' "$SKILL_JSON" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.skill !== "itpay-buyer" || json.role !== "buyer" || !json.path || !json.content.includes("Non-Negotiable Rules")) process.exit(1);})'
LEGACY_SKILL_JSON=$(HOME="$TMP_HOME" "$ROOT/bin/itp" skill show --role voltagent --json)
printf '%s' "$LEGACY_SKILL_JSON" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.skill !== "voltagent" || !json.content.includes("VoltaGent / ITPay Agent Runbook")) process.exit(1);})'
INSTALLED_SKILL_PATH=$(HOME="$TMP_HOME" "$TMP_PREFIX/bin/itp" skill path --role buyer)
test -f "$INSTALLED_SKILL_PATH"
HOME="$TMP_HOME" "$TMP_PREFIX/bin/itp" skill show --role buyer | grep -q "ItPay Buyer Agent Skill"
HOME="$TMP_HOME" "$ROOT/bin/itp" --help >/dev/null
HELP=$(HOME="$TMP_HOME" "$ROOT/bin/itp" --help)
printf '%s' "$HELP" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (!json.commands.includes("keys rotate --grant <grant_id>") || !json.commands.includes("checkout create --plan credit-300 --method alipay --idempotency-key <uuid>") || !json.commands.includes("checkout list --limit 20") || !json.commands.includes("setup --credits 100 --method alipay") || !json.commands.includes("setup --credits 100 --target codex --method alipay --install-runtime") || !json.commands.includes("status --json") || !json.commands.includes("resume --json") || !json.commands.includes("skill show")) process.exit(1);})'
printf '%s' "$HELP" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); for (const command of ["buy var_pubg_couple_skin_cny20 --sandbox --email buyer@example.com --phone +8613800000000 --json","buyer cart create --variant var_pubg_couple_skin_cny20 --json","buyer checkout create --cart <cart_id> --method alipay --email buyer@example.com --phone +8613800000000 --json","buyer payment wait <payment_intent_id> --json","buyer payment refresh-qr <payment_intent_id> --reason order-not-found --json","buyer deliveries list --checkout <checkout_id> --json","docs show quickstart --role buyer --json","ops sandbox worker run-once --json"]) { if (!json.commands.includes(command)) process.exit(1); }})'
DOCS_LIST=$(HOME="$TMP_HOME" "$ROOT/bin/itp" docs list --role buyer --json)
printf '%s' "$DOCS_LIST" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.schema_version !== "itp.agent_doc_index.v1" || !json.topics.some((topic)=>topic.topic==="cart-checkout")) process.exit(1);})'
DOCS_SHOW=$(HOME="$TMP_HOME" "$ROOT/bin/itp" docs show quickstart --role buyer --json)
printf '%s' "$DOCS_SHOW" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.topic !== "quickstart" || !Array.isArray(json.next_docs) || !json.next_docs.length) process.exit(1);})'
DOCS_SEARCH=$(HOME="$TMP_HOME" "$ROOT/bin/itp" docs search "付款 等待" --role buyer --json)
printf '%s' "$DOCS_SEARCH" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (!json.matches.some((match)=>match.topic==="payment-wait")) process.exit(1);})'
BUYER_AUTH_STATUS=$(HOME="$TMP_HOME" "$ROOT/bin/itp" buyer auth status --json)
printf '%s' "$BUYER_AUTH_STATUS" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.schema_version !== "itp.buyer.v1" || json.auth_required_for_discovery !== false) process.exit(1); if (data.toLowerCase().includes("ops-token") || data.toLowerCase().includes("sandbox_ops_token")) process.exit(1);})'
SNAPSHOT_VERSION_TRAP=$(HOME="$TMP_HOME" "$ROOT/bin/itp" buyer shelf snapshot --version dummy --json 2>/dev/null || true)
if printf '%s' "$SNAPSHOT_VERSION_TRAP" | grep -q '"version"'; then
  echo "buyer shelf snapshot --version was intercepted by top-level version handler" >&2
  exit 1
fi
CHECKOUT_STATUS_TRAP=$(HOME="$TMP_HOME" "$ROOT/bin/itp" buyer checkout status --json 2>&1 >/dev/null || true)
printf '%s' "$CHECKOUT_STATUS_TRAP" | grep -q "checkout_id is required"
MOCK_LOG="$TMP_HOME/mock-core-requests.jsonl"
MOCK_PORT_FILE="$TMP_HOME/mock-core-port"
cat >"$TMP_HOME/mock-core.mjs" <<'JS'
import fs from "node:fs";
import http from "node:http";

const logFile = process.env.MOCK_LOG;
const portFile = process.env.MOCK_PORT_FILE;

function writeJSON(res, status, payload) {
  res.writeHead(status, {"Content-Type": "application/json"});
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({raw: data});
      }
    });
  });
}

const product = {
  operation: "get_product",
  product: {
    id: "cat_pubg_sandbox_topup",
    title: "PUBG Mobile Sandbox Top-Up",
    description: "Sandbox service for ItPay end-to-end buyer testing.",
    selected: {variant_id: "var_pubg_couple_skin_cny20", catalog_version: "catv_pubg_sandbox_20260609"},
    metadata: {
      "ai.itpay.catalog_version": "catv_pubg_sandbox_20260609",
      "ai.itpay.required_profile_fields": ["email", "phone"]
    },
    variants: [{
      id: "var_pubg_couple_skin_cny20",
      title: "Couple Skin Pack",
      description: "Low-cost couple skin sandbox pack.",
      price: {amount: 2000, currency: "CNY"},
      availability: {status: "available", available: true},
      metadata: {
        "ai.itpay.offer_id": "offer_pubg_couple_skin_cny20",
        "ai.itpay.catalog_version": "catv_pubg_sandbox_20260609",
        "ai.itpay.required_profile_fields": ["email", "phone"]
      }
    }, {
      id: "var_pubg_deluxe_skin_cny40",
      title: "Deluxe Skin Pack",
      description: "Higher-value deluxe sandbox pack.",
      price: {amount: 4000, currency: "CNY"},
      availability: {status: "available", available: true},
      metadata: {
        "ai.itpay.offer_id": "offer_pubg_deluxe_skin_cny40",
        "ai.itpay.catalog_version": "catv_pubg_sandbox_20260609",
        "ai.itpay.required_profile_fields": ["email", "phone"]
      }
    }]
  },
  messages: []
};

const cart = {
  operation: "create_cart",
  id: "cart_mock_pubg",
  cart_id: "cart_mock_pubg",
  status: "active",
  currency: "CNY",
  amount: 2000,
  line_items: [{
    id: "cli_mock_line",
    item: {
      id: "var_pubg_couple_skin_cny20",
      title: "Couple Skin Pack",
      catalog_item_id: "cat_pubg_sandbox_topup",
      catalog_variant_id: "var_pubg_couple_skin_cny20",
      offer_id: "offer_pubg_couple_skin_cny20",
      catalog_version: "catv_pubg_sandbox_20260609",
      price: {amount: 2000, currency: "CNY"}
    },
    quantity: 1,
    amount: 2000,
    currency: "CNY"
  }],
  checkout_handoff: {cart_id: "cart_mock_pubg", checkout_path: "/api/ucp/v1/checkouts"},
  agent_next_actions: ["create_checkout_from_cart"],
  sensitive_redacted: true
};

const catalogSearch = {
  operation: "search_catalog",
  query: "企业工商信息 查询",
  products: [{
    id: "cat_itpay_enterprise_precise_lookup",
    title: "ItPay 自营企业工商数据精准查询",
    description: "按完整企业名称或统一社会信用代码查询中国大陆企业工商登记资料。",
    categories: ["business_data_api", "company_lookup"],
    price_range: {min: {amount: 50, currency: "CNY"}, max: {amount: 50, currency: "CNY"}},
    variants: [{
      id: "var_itpay_enterprise_precise_lookup_cny05",
      title: "ItPay 自营企业工商数据精准查询 单次查询",
      price: {amount: 50, currency: "CNY"},
      availability: {status: "available", available: true},
      metadata: {
        "ai.itpay.offer_id": "offer_itpay_enterprise_precise_lookup_cny05",
        "ai.itpay.catalog_version": "catv_itpay_enterprise_data_001",
        "ai.itpay.sensitivity_level": "business_sensitive",
        "ai.itpay.delivery_mode": "managed_capability",
        "ai.itpay.agent_may_view_raw_result": "false"
      }
    }],
    metadata: {
      "ai.itpay.taxonomy.category": "business_data_api",
      "ai.itpay.provider": "itpay_enterprise_data",
      "ai.itpay.provider_product_id": "81api_company_base_info",
      "ai.itpay.sensitivity_level": "business_sensitive",
      "ai.itpay.delivery_mode": "managed_capability"
    }
  }],
  messages: [],
  pagination: {limit: 10}
};

const checkout = {
  checkout_id: "chk_mock_pubg",
  cart_id: "cart_mock_pubg",
  status: "requires_payment",
  catalog_item_id: "cat_pubg_sandbox_topup",
  catalog_variant_id: "var_pubg_couple_skin_cny20",
  offer_id: "offer_pubg_couple_skin_cny20",
  amount: 2000,
  currency: "CNY",
  delivery: {status: "not_ready", sensitive_content_redacted: true},
  agent_next_actions: ["create_payment_intent"]
};

const intent = {
  payment_intent_id: "pi_mock_pubg",
  payment_attempt_id: "pa_mock_pubg",
  checkout_id: "chk_mock_pubg",
  status: "waiting_user_payment",
  amount: 2000,
  currency: "CNY",
  human_action: {
    kind: "payment_qr",
    qr_png_url: "http://127.0.0.1/mock-qr.png",
    qr_image_url: "http://127.0.0.1/mock-qr.svg",
    mobile_wallet_url: "http://127.0.0.1/mock-mobile-wallet",
    url: "http://127.0.0.1/mock-pay"
  },
  qr_png_url: "http://127.0.0.1/mock-qr.png",
  qr_image_url: "http://127.0.0.1/mock-qr.svg",
  mobile_wallet_url: "http://127.0.0.1/mock-mobile-wallet",
  agent_wait: {
    recommended: "long_poll",
    wait_url: "/v1/payment-intents/pi_mock_pubg/events/wait",
    cursor: "0",
    timeout_seconds: 25
  },
  agent_next_actions: ["wait_payment"]
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = await readBody(req);
  fs.appendFileSync(logFile, JSON.stringify({method: req.method, path: url.pathname, body}) + "\n");
  if (req.method === "POST" && url.pathname === "/api/ucp/v1/catalog/search") return writeJSON(res, 200, catalogSearch);
  if (req.method === "POST" && url.pathname === "/api/ucp/v1/catalog/product") return writeJSON(res, 200, product);
  if (req.method === "POST" && url.pathname === "/api/ucp/v1/carts") return writeJSON(res, 201, cart);
  if (req.method === "GET" && url.pathname === "/api/ucp/v1/carts/cart_mock_pubg") return writeJSON(res, 200, cart);
  if (req.method === "POST" && url.pathname === "/api/ucp/v1/checkouts") return writeJSON(res, 202, checkout);
  if (req.method === "POST" && url.pathname === "/v1/checkouts/chk_mock_pubg/payment-intents") return writeJSON(res, 202, intent);
  if (req.method === "POST" && url.pathname === "/v1/buyer/accounts/ba_mock_0376/portal-login-links") {
    if (req.headers.authorization !== "Bearer sess_mock_0376") return writeJSON(res, 401, {error: "missing buyer session"});
    return writeJSON(res, 201, {
      login_link_id: "apl_mock_0376",
      buyer_account_id: "ba_mock_0376",
      login_url: "https://itpay.ai/v1/account-portal/login/apl_mock_0376?token=human-only",
      expires_at: "2026-06-11T16:00:00Z",
      one_time: true,
      sensitive_redacted: true,
      agent_next_actions: ["show_login_link_to_human_only"]
    });
  }
  return writeJSON(res, 404, {error: "not found", path: url.pathname});
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
JS
MOCK_LOG="$MOCK_LOG" MOCK_PORT_FILE="$MOCK_PORT_FILE" node "$TMP_HOME/mock-core.mjs" &
MOCK_SERVER_PID=$!
i=0
while [ ! -s "$MOCK_PORT_FILE" ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done
if [ ! -s "$MOCK_PORT_FILE" ]; then
  echo "mock core server did not start" >&2
  exit 1
fi
MOCK_PORT=$(cat "$MOCK_PORT_FILE")
SEARCH_OUTPUT=$(HOME="$TMP_HOME" ITPAY_API_BASE="http://127.0.0.1:$MOCK_PORT" "$ROOT/bin/itp" buyer catalog search --query "企业工商信息 查询" --category business_data_api --provider itpay_enterprise_data --service-type ai_api --delivery-mode managed_capability --sensitivity-level business_sensitive --use-case company_lookup --input-facet company_name --requires-webauthn-reveal true --json)
printf '%s' "$SEARCH_OUTPUT" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.status !== "catalog_search_results" || !json.products.some((product)=>product.id==="cat_itpay_enterprise_precise_lookup")) process.exit(1);})'
BUY_OUTPUT=$(HOME="$TMP_HOME" ITPAY_API_BASE="http://127.0.0.1:$MOCK_PORT" "$ROOT/bin/itp" buy var_pubg_couple_skin_cny20 --sandbox --email buyer@example.com --phone +8613800000000 --no-wait --json)
printf '%s' "$BUY_OUTPUT" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.status !== "waiting_user_payment" || json.cart.cart_id !== "cart_mock_pubg" || json.checkout.checkout_id !== "chk_mock_pubg" || json.payment_intent.payment_intent_id !== "pi_mock_pubg") process.exit(1); if (json.payment_intent.human_action.preferred_qr_url !== "http://127.0.0.1/mock-qr.png") process.exit(1); if (json.payment_intent.human_action.agent_display_hint.primary !== "qr_png_url") process.exit(1); if (json.payment_intent.human_action.mobile_wallet_url !== "http://127.0.0.1/mock-mobile-wallet") process.exit(1); if (!json.docs.some((doc)=>doc.topic==="payment-wait")) process.exit(1); if (JSON.stringify(json).includes("issue_payment_proof")) process.exit(1);})'
MULTI_CART_OUTPUT=$(HOME="$TMP_HOME" ITPAY_API_BASE="http://127.0.0.1:$MOCK_PORT" "$ROOT/bin/itp" buyer cart create --variants var_pubg_couple_skin_cny20,var_pubg_deluxe_skin_cny40 --quantities 1,2 --json)
printf '%s' "$MULTI_CART_OUTPUT" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.status !== "cart_created" || json.cart.cart_id !== "cart_mock_pubg") process.exit(1);})'
node - <<'JS' "$TMP_HOME/.itp/config.json" "$TMP_HOME/.itp/credentials.json"
const fs = require("fs");
const [configPath, credentialsPath] = process.argv.slice(2);
fs.writeFileSync(configPath, JSON.stringify({account_id: "ba_mock_0376"}, null, 2), {mode: 0o600});
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
credentials.session_token = "sess_mock_0376";
fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), {mode: 0o600});
JS
PORTAL_LINK_OUTPUT=$(HOME="$TMP_HOME" ITPAY_CORE_API_BASE="http://127.0.0.1:$MOCK_PORT" "$ROOT/bin/itp" account login-link --json)
printf '%s' "$PORTAL_LINK_OUTPUT" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.status !== "account_portal_login_link_created" || json.portal_login_link.one_time !== true) process.exit(1); if (!json.login_url.includes("/v1/account-portal/login/")) process.exit(1); if (json.next.safe_for_agent !== false || json.next.requires_human !== true || json.next.agent_must_not_open !== true) process.exit(1);})'
node - <<'JS' "$TMP_HOME/.itp/credentials.json"
const fs = require("fs");
const credentialsPath = process.argv[2];
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
delete credentials.session_token;
delete credentials.session_token_store;
delete credentials.session_token_ref;
fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), {mode: 0o600});
JS
node -e 'const fs=require("fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/).map(JSON.parse); const has=(m,p)=>rows.some(r=>r.method===m&&r.path===p); if(!has("POST","/api/ucp/v1/catalog/product")||!has("POST","/api/ucp/v1/carts")||!has("POST","/api/ucp/v1/checkouts")||!has("POST","/v1/checkouts/chk_mock_pubg/payment-intents")) process.exit(1); if(has("POST","/v1/checkouts")) process.exit(1);' "$MOCK_LOG"
node -e 'const fs=require("fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/).map(JSON.parse); const multi=rows.find(r=>r.method==="POST"&&r.path==="/api/ucp/v1/carts"&&Array.isArray(r.body.line_items)&&r.body.line_items.length===2); if(!multi) process.exit(1); if(multi.body.line_items[0].item.id!=="var_pubg_couple_skin_cny20"||multi.body.line_items[0].quantity!==1||multi.body.line_items[1].item.id!=="var_pubg_deluxe_skin_cny40"||multi.body.line_items[1].quantity!==2) process.exit(1);' "$MOCK_LOG"
node -e 'const fs=require("fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/).map(JSON.parse); const search=rows.find(r=>r.method==="POST"&&r.path==="/api/ucp/v1/catalog/search"); if(!search) process.exit(1); const f=search.body.filters||{}; if(!Array.isArray(f.categories)||f.categories[0]!=="business_data_api") process.exit(1); if(f["ai.itpay.provider"]!=="itpay_enterprise_data"||f["ai.itpay.service_type"]!=="ai_api"||f["ai.itpay.delivery_mode"]!=="managed_capability"||f["ai.itpay.sensitivity_level"]!=="business_sensitive") process.exit(1); if(!Array.isArray(f["ai.itpay.taxonomy.use_cases"])||f["ai.itpay.taxonomy.use_cases"][0]!=="company_lookup") process.exit(1); if(!Array.isArray(f["ai.itpay.taxonomy.input_facets"])||f["ai.itpay.taxonomy.input_facets"][0]!=="company_name") process.exit(1); if(f["ai.itpay.requires_webauthn_reveal"]!==true) process.exit(1);' "$MOCK_LOG"
kill "$MOCK_SERVER_PID" >/dev/null 2>&1 || true
MOCK_SERVER_PID=""
AGENT_STATUS=$(HOME="$TMP_HOME" "$ROOT/bin/itp" status --json)
printf '%s' "$AGENT_STATUS" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data); if (json.schema_version !== "itp.agent.v1" || json.status !== "unauthenticated" || json.secrets.raw_key_included !== false) process.exit(1);})'
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
