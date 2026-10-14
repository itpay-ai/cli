//go:build localux

package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"github.com/itpay-ai/compose/services/backend/internal/adapters/system"
	"github.com/itpay-ai/compose/services/backend/internal/domain/identity"
	"github.com/itpay-ai/compose/services/backend/internal/httpapi/handlers"
	"github.com/itpay-ai/compose/services/backend/internal/ports"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func localTestConfig(t *testing.T) Config {
	t.Helper()
	t.Setenv("ITPAY_LOCAL_UX_DIR", t.TempDir())
	t.Setenv("ITPAY_LOCAL_UX_CALLBACK_SECRET", strings.Repeat("a", 64))
	return Config{HTTPAddr: "127.0.0.1:18081", DeploymentProfile: "local", DatabaseURL: "postgres://local@127.0.0.1:25441/itpay_local_ux", CheckoutBaseURL: "http://127.0.0.1:15173", RailPlannerURL: "http://127.0.0.1:18765", TemporalAddress: "127.0.0.1:27233", TemporalNamespace: "itpay-local-ux", TemporalTaskQueue: "itpay-local-ux", SMSProvider: "fake", EmailProvider: "fake", SMSFakeSinkPath: labDir() + "/inbox/sms.log", ServiceProviderMode: "live"}
}
func TestLocalIsolation(t *testing.T) {
	cfg := localTestConfig(t)
	if e := validateLocalUX(cfg); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*Config){func(c *Config) { c.DeploymentProfile = "dev" }, func(c *Config) { c.DatabaseURL = "postgres://local@dev.itpay.ai/itpay_local_ux" }, func(c *Config) { c.CheckoutBaseURL = "https://dev.itpay.ai" }, func(c *Config) { c.AlipayMerchantPrivateKeyPEM = "live" }, func(c *Config) { c.SMSProvider = "aliyun" }, func(c *Config) { c.ServiceProviderMode = "mock" }} {
		bad := cfg
		change(&bad)
		if validateLocalUX(bad) == nil {
			t.Fatal("unsafe configuration accepted")
		}
	}
}
func TestLocalPaymentBoundaries(t *testing.T) {
	cfg := localTestConfig(t)
	p := localPayment{labDir(), cfg.CheckoutBaseURL}
	a, e := p.CreatePagePay(context.Background(), ports.AlipayPagePayRequest{PaymentAttemptID: "attempt_one", OrderID: "order_one", OrderCode: "LOCAL_ONE", CheckoutID: "checkout_one", ReturnURL: cfg.CheckoutBaseURL + "/checkout/checkout_one?display_token=synthetic", AmountMinor: 53100, TimeoutExpress: "5m"})
	if e != nil {
		t.Fatal(e)
	}
	changed := ports.AlipayPagePayRequest{PaymentAttemptID: "attempt_one", OrderID: "order_one", AmountMinor: 53101, TimeoutExpress: "5m"}
	if _, err := p.CreatePagePay(context.Background(), changed); err == nil {
		t.Fatal("same attempt accepted a changed amount")
	}
	u, _ := url.Parse(a.PaymentURL)
	v := u.Query()
	if !loopbackURL(a.PaymentURL) {
		t.Fatal("nonlocal payment")
	}
	calls := 0
	h := wrapLocalUX(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		r.ParseForm()
		if p.VerifyNotification(r.Form) != nil {
			t.Error("proof invalid")
		}
		w.WriteHeader(200)
	}))
	for _, change := range []func(url.Values, *http.Request){func(v url.Values, r *http.Request) { v.Set("secret", "wrong") }, func(v url.Values, r *http.Request) { v.Set("attempt", "other") }, func(v url.Values, r *http.Request) { r.Header.Set("Origin", "https://dev.itpay.ai") }} {
		input := url.Values{}
		for k, x := range v {
			input[k] = x
		}
		input.Set("action", "success")
		r := httptest.NewRequest("POST", cfg.CheckoutBaseURL+"/v1/local-ux/pay", nil)
		r.Header.Set("Origin", cfg.CheckoutBaseURL)
		change(input, r)
		r.Body = http.NoBody
		r = httptest.NewRequest("POST", cfg.CheckoutBaseURL+"/v1/local-ux/pay", strings.NewReader(input.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", cfg.CheckoutBaseURL)
		change(input, r)
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		if out.Code != 403 {
			t.Fatalf("unsafe callback %d", out.Code)
		}
	}
	if calls != 0 {
		t.Fatal("unsafe callbacks reached owner")
	}
	for range 2 {
		v.Set("action", "success")
		r := httptest.NewRequest("POST", cfg.CheckoutBaseURL+"/v1/local-ux/pay", strings.NewReader(v.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", cfg.CheckoutBaseURL)
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		if out.Code != http.StatusOK || !strings.Contains(out.Body.String(), "模拟付款完成") || !strings.Contains(out.Body.String(), "出票或报告交付均为本地模拟") || !strings.Contains(out.Body.String(), "模拟票号不可用于12306核验") || strings.Contains(out.Body.String(), "模拟出票需等待") || !strings.Contains(out.Body.String(), "返回同一收银台查看订单") || strings.Contains(out.Body.String(), "href='/orders/") {
			t.Fatal("local payment lost the original checkout return path")
		}
	}
	if calls != 2 {
		t.Fatal("duplicate simulated notifications did not reach the normal payment owner")
	}
	forged := url.Values{"trade_no": {"localux_fake"}, "sign": {"fake"}}
	if p.VerifyNotification(forged) == nil {
		t.Fatal("forgery accepted")
	}
}
func TestLocalRailUnknownAndPersistence(t *testing.T) {
	localTestConfig(t)
	request := ports.ServiceProviderAdapterRequest{TrustedExecutionID: "exec_local"}
	if e := writeLabJSON(labDir()+"/scenario.json", localScenario{ExecutionID: "exec_local", Mode: "unknown_pay"}); e != nil {
		t.Fatal(e)
	}
	params := map[string]any{"base_price": "20.50", "order_detail_json": map[string]any{"trainCode": "observed_train", "seatTypeName": "二等座", "orderTouristList": []any{map[string]any{"name": "测试乘客", "idCard": "synthetic", "phone": "19900000001"}}}}
	created, e := railTransactionCall(Config{}, request, context.Background(), "order_create", "rail:exec_local:0:1", params)
	if e != nil {
		t.Fatal(e)
	}
	a, _ := created.Object()
	repeat, e := railTransactionCall(Config{}, request, context.Background(), "order_create", "rail:exec_local:0:1", params)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := repeat.Object()
	if a["order_id"] != b["order_id"] {
		t.Fatal("duplicate order")
	}
	if _, e = railTransactionCall(Config{}, request, context.Background(), "order_detail", "rail:exec_local:0:before-pay", map[string]any{"order_id": a["order_id"]}); e != nil {
		t.Fatal("unknown-pay fixture blocked pre-payment verification")
	}
	_, e = railTransactionCall(Config{}, request, context.Background(), "create_pay_info", "rail:exec_local:0:pay", map[string]any{"order_id": a["order_id"], "pay_type": 2})
	if e == nil {
		t.Fatal("unknown scenario not injected")
	}
	if _, e = railTransactionCall(Config{}, request, context.Background(), "order_detail", "rail:exec_local:0:hold", map[string]any{"order_id": a["order_id"]}); e == nil {
		t.Fatal("unknown did not remain held")
	}
	if e = writeLabJSON(labDir()+"/rail/"+fmt.Sprint(a["order_id"])+".json.release", true); e != nil {
		t.Fatal(e)
	}
	r, e := railTransactionCall(Config{}, request, context.Background(), "order_detail", "rail:exec_local:0:3", map[string]any{"order_id": a["order_id"]})
	if e != nil {
		t.Fatal(e)
	}
	v, _ := r.Object()
	if v["order_status"] != "ISSUED" || v["local_simulation"] != true {
		t.Fatal("persisted read lost paid fact")
	}
	if _, e = railTransactionCall(Config{}, request, context.Background(), "unknown", "rid", params); e == nil {
		t.Fatal("unknown operation accepted")
	}
}

type localOAuthAuthStore struct {
	ports.AuthStore
	session identity.DashboardAuthSession
}

func (s localOAuthAuthStore) GetDashboardAuthSessionByStartTokenHash(_ context.Context, id, hash string) (identity.DashboardAuthSession, error) {
	if id != s.session.ID || hash != s.session.StartTokenHash {
		return identity.DashboardAuthSession{}, errors.New("invalid state")
	}
	return s.session, nil
}
func TestLocalOAuthBoundConsentCancelExpiryReplay(t *testing.T) {
	cfg := localTestConfig(t)
	oauth := localOAuth{labDir(), cfg.CheckoutBaseURL}
	secrets := system.NewIDs()
	d := &handlers.Dependencies{Secrets: secrets, Auth: localOAuthAuthStore{session: identity.DashboardAuthSession{ID: "das_local", StartTokenHash: secrets.HashSecret("start_local"), ExpiresAt: time.Now().Add(time.Minute), RedirectURL: cfg.CheckoutBaseURL + "/checkout/local?display_token=synthetic"}}}
	entry, err := oauth.AuthorizationURL("das_local", "start_local")
	if err != nil {
		t.Fatal(err)
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := oauth.ExchangeAuthorizationCode(r.Context(), r.URL.Query().Get("auth_code")); err != nil {
			http.Error(w, err.Error(), 403)
			return
		}
		http.Redirect(w, r, cfg.CheckoutBaseURL+"/checkout/local", 302)
	})
	h := wrapLocalUX(cfg, next, d)
	out := httptest.NewRecorder()
	h.ServeHTTP(out, httptest.NewRequest("GET", entry, nil))
	if out.Code != 200 || !strings.Contains(out.Body.String(), "不会连接真实支付宝或扣款") {
		t.Fatal("missing local consent")
	}
	u, _ := url.Parse(entry)
	input := u.Query()
	input.Set("action", "cancel")
	post := func(values url.Values) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", entry, strings.NewReader(values.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.Header.Set("Origin", cfg.CheckoutBaseURL)
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		return out
	}
	if out := post(input); out.Code != 303 || !strings.Contains(out.Header().Get("Location"), "/checkout/local") {
		t.Fatal("cancel did not return original checkout")
	}
	input.Set("action", "agree")
	out = post(input)
	if out.Code != 303 {
		t.Fatal(out.Body.String())
	}
	callback := out.Header().Get("Location")
	cu, _ := url.Parse(callback)
	code, state := cu.Query().Get("auth_code"), cu.Query().Get("state")
	if oauth.validCode(code, "wrong") {
		t.Fatal("cross-state code accepted")
	}
	if _, err := oauth.ExchangeAuthorizationCode(context.Background(), code); err == nil {
		t.Fatal("direct cross-checkout redemption accepted")
	}
	out = httptest.NewRecorder()
	h.ServeHTTP(out, httptest.NewRequest("GET", callback, nil))
	if out.Code != 302 {
		t.Fatal("bound callback failed", out.Code)
	}
	if oauth.validCode(code, state) {
		t.Fatal("code replay accepted")
	}
	out = httptest.NewRecorder()
	h.ServeHTTP(out, httptest.NewRequest("GET", callback, nil))
	if out.Code != 403 {
		t.Fatal("callback replay accepted")
	}
	path, _ := oauth.path("code", code)
	if err := writeLabJSON(path, localAuthorization{State: state, Expires: time.Now().Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	if oauth.validCode(code, state) {
		t.Fatal("expired code accepted")
	}
	t.Log("consent and cancel stay loopback; wrong state, direct redemption, replay and expiry rejected")
}
