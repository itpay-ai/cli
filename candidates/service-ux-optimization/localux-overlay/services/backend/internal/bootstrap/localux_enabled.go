//go:build localux

package bootstrap

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/itpay-ai/compose/services/backend/internal/adapters/paymentrouter"
	"github.com/itpay-ai/compose/services/backend/internal/adapters/providers"
	"github.com/itpay-ai/compose/services/backend/internal/httpapi/handlers"
	"github.com/itpay-ai/compose/services/backend/internal/ports"
	"html"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

func labDir() string { return os.Getenv("ITPAY_LOCAL_UX_DIR") }
func loopbackURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.User == nil
}
func validateLocalUX(cfg Config) error {
	u, e := url.Parse(cfg.DatabaseURL)
	host, _, he := net.SplitHostPort(cfg.HTTPAddr)
	if labDir() == "" || !filepath.IsAbs(labDir()) || cfg.DeploymentProfile != "local" || he != nil || host != "127.0.0.1" || e != nil || u.Hostname() != "127.0.0.1" || u.Path != "/itpay_local_ux" || !loopbackURL(cfg.CheckoutBaseURL) || !loopbackURL(cfg.RailPlannerURL) || cfg.TemporalAddress != "127.0.0.1:27233" || cfg.TemporalNamespace != "itpay-local-ux" || cfg.TemporalTaskQueue != "itpay-local-ux" {
		return errors.New("localux requires explicit private lab directory, local profile, loopback services and isolated database/Temporal")
	}
	if !cfg.LiveServiceProviders() || cfg.SMSProvider != "fake" || cfg.EmailProvider != "fake" || cfg.AlipayMerchantPrivateKeyPEM != "" || cfg.AlipayPublicKeyPEM != "" || cfg.WechatPayEnabled || cfg.WechatOAuthEnabled || cfg.ResendAPIKey != "" || cfg.SMSAliyunAccessKeyID != "" || cfg.SMSAliyunAccessKeySecret != "" || cfg.MCPOAuthAdminURL != "" {
		return errors.New("localux forbids live wallet/OAuth/notification credentials and global provider mock")
	}
	if cfg.ActionCardRendererURL != "" && !loopbackURL(cfg.ActionCardRendererURL) {
		return errors.New("localux renderer must be loopback")
	}
	if !strings.HasPrefix(filepath.Clean(cfg.SMSFakeSinkPath), filepath.Clean(labDir())+string(os.PathSeparator)) {
		return errors.New("localux SMS sink must belong to lab")
	}
	return nil
}

var labMutex sync.Mutex

func randomSecret() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func writeLabJSON(path string, v any) error {
	raw, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	if e = os.WriteFile(path+".tmp", raw, 0600); e != nil {
		return e
	}
	return os.Rename(path+".tmp", path)
}
func readLabJSON(path string, v any) error {
	raw, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	return d.Decode(v)
}

type localPayment struct{ dir, origin string }
type localAttempt struct {
	Request ports.AlipayPagePayRequest
	Secret  string
	Expires time.Time
}

func (p localPayment) path(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, "/\\.") {
		return "", errors.New("invalid local attempt")
	}
	return filepath.Join(p.dir, "payments", id+".json"), nil
}
func (p localPayment) CreatePagePay(_ context.Context, r ports.AlipayPagePayRequest) (ports.AlipayPagePayAction, error) {
	labMutex.Lock()
	defer labMutex.Unlock()
	path, e := p.path(r.PaymentAttemptID)
	if e != nil {
		return ports.AlipayPagePayAction{}, e
	}
	var a localAttempt
	if e = readLabJSON(path, &a); e != nil {
		if !os.IsNotExist(e) {
			return ports.AlipayPagePayAction{}, e
		}
		ttl, e := time.ParseDuration(r.TimeoutExpress)
		if e != nil || ttl <= 0 {
			return ports.AlipayPagePayAction{}, errors.New("local attempt requires expiry")
		}
		a = localAttempt{r, randomSecret(), time.Now().Add(ttl)}
		if e = writeLabJSON(path, a); e != nil {
			return ports.AlipayPagePayAction{}, e
		}
	} else if a.Request.OrderID != r.OrderID || a.Request.AmountMinor != r.AmountMinor {
		return ports.AlipayPagePayAction{}, errors.New("local attempt conflict")
	}
	link := p.origin + "/v1/local-ux/pay?attempt=" + url.QueryEscape(r.PaymentAttemptID) + "&secret=" + a.Secret
	return ports.AlipayPagePayAction{PaymentURL: link, QRCode: link, MobileWalletURL: link}, nil
}
func (p localPayment) sign(v url.Values) string {
	clone := url.Values{}
	for k, vs := range v {
		if k != "sign" {
			clone[k] = vs
		}
	}
	m := hmac.New(sha256.New, []byte(os.Getenv("ITPAY_LOCAL_UX_CALLBACK_SECRET")))
	m.Write([]byte(clone.Encode()))
	return hex.EncodeToString(m.Sum(nil))
}
func (p localPayment) VerifyNotification(v url.Values) error {
	if len(os.Getenv("ITPAY_LOCAL_UX_CALLBACK_SECRET")) < 32 || !hmac.Equal([]byte(v.Get("sign")), []byte(p.sign(v))) || !strings.HasPrefix(v.Get("trade_no"), "localux_") {
		return errors.New("invalid local proof")
	}
	return nil
}
func (p localPayment) SubmitRefund(_ context.Context, r ports.PaymentRefundRequest) (ports.PaymentRefundResult, error) {
	if !strings.HasPrefix(r.ProviderTradeNo, "localux_") || r.AmountMinor <= 0 || r.AmountMinor > r.OriginalAmountMinor {
		return ports.PaymentRefundResult{}, errors.New("not a local payment refund")
	}
	if v, e, handled := localRefundSequence(r, false); handled {
		return v, e
	}
	v := ports.PaymentRefundResult{Provider: r.Provider, ProviderRefundID: "localux_" + r.RefundRequestID, ProviderStatus: "REFUND_SUCCESS", Status: "succeeded", EvidenceHash: "localux:" + r.RefundRequestID, AmountMinor: r.AmountMinor, Currency: r.Currency}
	return v, writeLabJSON(filepath.Join(p.dir, "refunds", r.RefundRequestID+".json"), v)
}
func (p localPayment) QueryRefund(_ context.Context, r ports.PaymentRefundRequest) (ports.PaymentRefundResult, error) {
	if v, e, handled := localRefundSequence(r, true); handled {
		return v, e
	}
	var v ports.PaymentRefundResult
	e := readLabJSON(filepath.Join(p.dir, "refunds", r.RefundRequestID+".json"), &v)
	return v, e
}
func localRefundProvider(cfg Config) ports.PaymentRefundClient {
	return localPayment{labDir(), cfg.CheckoutBaseURL}
}
func wireLocalUX(cfg Config, d *handlers.Dependencies) error {
	if len(os.Getenv("ITPAY_LOCAL_UX_CALLBACK_SECRET")) < 32 {
		return errors.New("local callback secret missing")
	}
	p := localPayment{labDir(), cfg.CheckoutBaseURL}
	d.AlipayOAuth = localOAuth{labDir(), cfg.CheckoutBaseURL}
	d.AlipayOAuthRedirectURL = cfg.CheckoutBaseURL + "/v1/alipay/oauth/callback"
	d.AlipayPayment = p
	d.AlipayNotifyVerifier = p
	d.RefundProvider = paymentrouter.NewRefundRouter(map[string]ports.PaymentRefundClient{"alipay": p})
	return nil
}
func wrapLocalUX(cfg Config, next http.Handler, dependencies ...*handlers.Dependencies) http.Handler {
	p := localPayment{labDir(), cfg.CheckoutBaseURL}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if localFixtureFault(next, w, r) {
			return
		}
		w.Header().Set("X-ItPay-Environment", "local_simulation")
		if r.URL.Path == "/v1/alipay/oauth/callback" {
			oauth := localOAuth{labDir(), cfg.CheckoutBaseURL}
			code, state := r.URL.Query().Get("auth_code"), r.URL.Query().Get("state")
			if !oauth.validCode(code, state) {
				http.Error(w, "本地授权凭据无效、已使用或已过期", 403)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), localOAuthStateKey{}, state)))
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/v1/local-ux/") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'")
		if r.URL.Path == "/v1/local-ux/oauth" {
			if len(dependencies) == 0 {
				http.Error(w, "local auth unavailable", 503)
				return
			}
			localOAuth{labDir(), cfg.CheckoutBaseURL}.serve(w, r, dependencies[0])
			return
		}
		if r.URL.Path == "/v1/local-ux/inbox" && r.Method == "GET" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprint(w, "<h1>本地测试收件箱</h1><p>真实查询，短信、邮件及交易均模拟。测试手机号19900000001、邮箱ux@example.test。</p>")
			for _, f := range []string{"sms.log", "email.jsonl"} {
				raw, e := os.ReadFile(filepath.Join(p.dir, "inbox", f))
				if e == nil {
					fmt.Fprintf(w, "<h2>%s</h2><pre>%s</pre>", f, html.EscapeString(string(raw)))
				}
			}
			return
		}
		if r.URL.Path != "/v1/local-ux/pay" || (r.Method != "GET" && r.Method != "POST") {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if r.ParseForm() != nil {
			http.Error(w, "bad form", 400)
			return
		}
		path, e := p.path(r.Form.Get("attempt"))
		var a localAttempt
		if e != nil || readLabJSON(path, &a) != nil || !hmac.Equal([]byte(r.Form.Get("secret")), []byte(a.Secret)) || !time.Now().Before(a.Expires) {
			http.Error(w, "本地入口无效或已过期", 403)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == "GET" {
			fmt.Fprintf(w, "<h1>本地模拟，不会扣款</h1><p>订单%s · ¥%.2f · 截止%s</p><form method='post'><input type='hidden' name='attempt' value='%s'><input type='hidden' name='secret' value='%s'><button name='action' value='success'>模拟已扫码并支付成功</button><button name='action' value='cancel'>取消模拟付款</button></form>", html.EscapeString(a.Request.OrderCode), float64(a.Request.AmountMinor)/100, a.Expires.Format(time.RFC3339), a.Request.PaymentAttemptID, a.Secret)
			return
		}
		if r.Header.Get("Origin") != p.origin {
			http.Error(w, "invalid origin", 403)
			return
		}
		if r.Form.Get("action") == "cancel" {
			fmt.Fprint(w, "<h1>已取消本次模拟付款</h1><p>未发送支付成功通知。</p>")
			return
		}
		if r.Form.Get("action") != "success" {
			http.Error(w, "invalid action", 400)
			return
		}
		v := url.Values{"out_trade_no": {a.Request.OrderCode}, "trade_no": {"localux_" + a.Request.PaymentAttemptID}, "trade_status": {"TRADE_SUCCESS"}, "total_amount": {fmt.Sprintf("%.2f", float64(a.Request.AmountMinor)/100)}}
		v.Set("sign", p.sign(v))
		callback := httptest.NewRequest("POST", "/v1/alipay/sandbox/notify", strings.NewReader(v.Encode())).WithContext(r.Context())
		callback.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		out := httptest.NewRecorder()
		next.ServeHTTP(out, callback)
		if out.Code >= 300 {
			http.Error(w, "原支付状态机拒绝模拟通知", out.Code)
			return
		}
		returnURL, err := url.Parse(a.Request.ReturnURL)
		if err != nil || !loopbackURL(a.Request.ReturnURL) || !strings.HasPrefix(a.Request.ReturnURL, p.origin+"/") || returnURL.Path != "/checkout/"+a.Request.CheckoutID {
			http.Error(w, "模拟付款已通知，但原收银台返回入口无效；不要重新付款", http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, "<h1>模拟付款完成</h1><p>返回原订单查看当前服务的后续处理：出票或报告交付均为本地模拟，不是真实交易凭证。模拟票号不可用于12306核验。</p><a href='%s'>返回同一收银台查看订单</a>", html.EscapeString(a.Request.ReturnURL))
	})
}

type localMail struct{}

func localEmailSender(_ Config) ports.EmailSender { return localMail{} }
func (localMail) SendEmail(_ context.Context, m ports.EmailMessage) (ports.EmailSendResult, error) {
	if m.To != "ux@example.test" && m.To != "ux2@example.test" && m.To != "s1210-reviewer@example.test" {
		return ports.EmailSendResult{}, errors.New("local inbox only accepts synthetic ux/ux2@example.test")
	}
	raw, e := json.Marshal(m)
	if e != nil {
		return ports.EmailSendResult{}, e
	}
	labMutex.Lock()
	defer labMutex.Unlock()
	f, e := os.OpenFile(filepath.Join(labDir(), "inbox", "email.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return ports.EmailSendResult{}, e
	}
	defer f.Close()
	_, e = f.Write(append(raw, '\n'))
	return ports.EmailSendResult{ProviderMessageID: "localux_mail_" + randomSecret()}, e
}
func railTransactionCall(_ Config, request ports.ServiceProviderAdapterRequest, ctx context.Context, op, rid string, params map[string]any) (providers.TengyunResponse, error) {
	labMutex.Lock()
	defer labMutex.Unlock()
	if ctx.Err() != nil {
		return providers.TengyunResponse{}, ctx.Err()
	}
	if op != "order_create" && op != "create_pay_info" && op != "order_detail" {
		return providers.TengyunResponse{}, errors.New("local rail operation blocked")
	}
	record, _ := json.Marshal(map[string]any{"operation": op, "request_id": rid, "execution_id": request.TrustedExecutionID, "simulation": true, "time": time.Now().UTC()})
	logFile, err := os.OpenFile(filepath.Join(labDir(), "rail-calls.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return providers.TengyunResponse{}, err
	}
	_, err = logFile.Write(append(record, '\n'))
	logFile.Close()
	if err != nil {
		return providers.TengyunResponse{}, err
	}
	sum := sha256.Sum256([]byte(rid))
	id := strconv.FormatUint(uint64(sum[0])<<32|uint64(sum[1])<<24|uint64(sum[2])<<16|uint64(sum[3])<<8|uint64(sum[4]), 10)
	if op != "order_create" {
		id = fmt.Sprint(params["order_id"])
	}
	if _, e := strconv.ParseUint(id, 10, 64); e != nil {
		return providers.TengyunResponse{}, errors.New("invalid local order")
	}
	path := filepath.Join(labDir(), "rail", id+".json")
	var detail map[string]any
	e := readLabJSON(path, &detail)
	if op == "order_create" {
		if e != nil && !os.IsNotExist(e) {
			return providers.TengyunResponse{}, e
		}
		if detail == nil {
			raw, _ := json.Marshal(params["order_detail_json"])
			detail = map[string]any{"order_id": json.Number(id), "trade_no": "localux_rail_" + id, "service_type": "TRAIN", "travel_type": "BUSINESS", "account_type": "ENTERPRISE", "audit_status": "1", "order_status": "PENDING", "base_price": params["base_price"], "final_price": params["base_price"], "pay_amount": params["base_price"], "payment_amount": json.Number("0"), "order_detail_json": string(raw), "local_simulation": true}
			var scenario localScenario
			err := readLabJSON(filepath.Join(labDir(), "scenario.json"), &scenario)
			if err != nil && !os.IsNotExist(err) {
				return providers.TengyunResponse{}, err
			}
			if scenario.ExecutionID == request.TrustedExecutionID {
				detail["local_mode"] = scenario.Mode
			}
			parts := strings.Split(rid, ":")
			if len(parts) >= 3 {
				detail["local_leg"] = parts[len(parts)-2]
			}
			e = writeLabJSON(path, detail)
		}
	} else if e != nil {
		return providers.TengyunResponse{}, e
	}
	if op == "create_pay_info" {
		if params["pay_type"] != 2 {
			return providers.TengyunResponse{}, errors.New("invalid local pay type")
		}
		detail["order_status"] = "ISSUED"
		detail["payment_amount"] = detail["base_price"]
		var input map[string]any
		json.Unmarshal([]byte(detail["order_detail_json"].(string)), &input)
		people, _ := input["orderTouristList"].([]any)
		tourists := []any{}
		for i, v := range people {
			person, _ := v.(map[string]any)
			tourists = append(tourists, map[string]any{"idCard": person["idCard"], "seatTypeName": input["seatTypeName"], "seatNo": fmt.Sprintf("03车%02dA", i+1), "ticketNo": "LOCAL_SIMULATION"})
		}
		detail["touristList"] = tourists
		if detail["local_mode"] == "issuing_first" && detail["local_leg"] == "0" {
			detail["order_status"] = "ISSUING"
			detail["local_issuing_reads"] = 0
		}
		if detail["local_mode"] == "partial_failure" && detail["local_leg"] == "1" {
			detail["order_status"] = "FAILED"
		}
		e = writeLabJSON(path, detail)
		if detail["local_mode"] == "unknown_pay" && detail["local_leg"] == "0" {
			return providers.TengyunResponse{}, providers.ErrTengyunUnavailable
		}
	}
	if op == "order_detail" && detail["local_mode"] == "unknown_pay" && detail["local_leg"] == "0" && detail["order_status"] == "ISSUED" {
		if _, err := os.Stat(path + ".release"); os.IsNotExist(err) {
			return providers.TengyunResponse{}, providers.ErrTengyunUnavailable
		}
	}
	if op == "order_detail" && detail["order_status"] == "ISSUING" {
		n, _ := strconv.Atoi(fmt.Sprint(detail["local_issuing_reads"]))
		n++
		detail["local_issuing_reads"] = n
		if n >= 3 {
			detail["order_status"] = "ISSUED"
		}
		if err := writeLabJSON(path, detail); err != nil {
			return providers.TengyunResponse{}, err
		}
	}
	raw, _ := json.Marshal(detail)
	return providers.TengyunResponse{Code: json.Number("0"), Data: raw}, e
}

type localScenario struct {
	ExecutionID string `json:"execution_id"`
	Mode        string `json:"mode"`
}

// Only the localux build wires this adapter. Codes cannot be redeemed through
// another checkout or the direct-code endpoint: the bound callback sets context.
type localOAuth struct{ dir, origin string }
type localOAuthStateKey struct{}
type localAuthorization struct {
	SessionID, State string
	Expires          time.Time
	Used             bool
}

func (o localOAuth) path(kind, id string) (string, error) {
	if len(id) != 64 {
		return "", errors.New("invalid local authorization")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return "", err
	}
	return filepath.Join(o.dir, "oauth", kind+"-"+id+".json"), nil
}
func (o localOAuth) AuthorizationURL(sessionID, state string) (string, error) {
	if sessionID == "" || state == "" {
		return "", errors.New("authorization state missing")
	}
	id := randomSecret()
	path, _ := o.path("request", id)
	if err := writeLabJSON(path, localAuthorization{SessionID: sessionID, State: sessionID + "." + state, Expires: time.Now().Add(5 * time.Minute)}); err != nil {
		return "", err
	}
	return o.origin + "/v1/local-ux/oauth?request=" + id + "&state=" + url.QueryEscape(sessionID+"."+state), nil
}
func (o localOAuth) validCode(code, state string) bool {
	labMutex.Lock()
	defer labMutex.Unlock()
	path, err := o.path("code", code)
	var a localAuthorization
	return err == nil && readLabJSON(path, &a) == nil && !a.Used && time.Now().Before(a.Expires) && hmac.Equal([]byte(a.State), []byte(state))
}
func (o localOAuth) ExchangeAuthorizationCode(ctx context.Context, code string) (ports.ProviderOAuthUser, error) {
	labMutex.Lock()
	defer labMutex.Unlock()
	path, err := o.path("code", code)
	var a localAuthorization
	state, _ := ctx.Value(localOAuthStateKey{}).(string)
	if err != nil || readLabJSON(path, &a) != nil || a.Used || !time.Now().Before(a.Expires) || state == "" || !hmac.Equal([]byte(state), []byte(a.State)) {
		return ports.ProviderOAuthUser{}, errors.New("invalid or replayed local authorization")
	}
	a.Used = true
	if err = writeLabJSON(path, a); err != nil {
		return ports.ProviderOAuthUser{}, err
	}
	return ports.ProviderOAuthUser{ProviderSubject: "localux-desktop-buyer", DisplayName: "本地测试买家"}, nil
}
func (o localOAuth) serve(w http.ResponseWriter, r *http.Request, d *handlers.Dependencies) {
	if r.Method != "GET" && r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if r.ParseForm() != nil {
		http.Error(w, "bad form", 400)
		return
	}
	path, err := o.path("request", r.Form.Get("request"))
	var a localAuthorization
	if err != nil || readLabJSON(path, &a) != nil || a.Used || !time.Now().Before(a.Expires) || d.Auth == nil || d.Secrets == nil {
		http.Error(w, "本地授权请求无效或已过期", 403)
		return
	}
	parts := strings.SplitN(a.State, ".", 2)
	if len(parts) != 2 {
		http.Error(w, "invalid state", 403)
		return
	}
	session, err := d.Auth.GetDashboardAuthSessionByStartTokenHash(r.Context(), a.SessionID, d.Secrets.HashSecret(parts[1]))
	if err != nil || !time.Now().Before(session.ExpiresAt) {
		http.Error(w, "授权会话无效或已过期", 403)
		return
	}
	if r.Method == "GET" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, "<h1>本地模拟支付宝授权</h1><p>不会连接真实支付宝或扣款。仅在本机建立测试身份，返回原收银台。</p><form method='post'><input type='hidden' name='request' value='%s'><button name='action' value='agree'>同意模拟授权</button><button name='action' value='cancel'>取消并返回收银台</button></form>", r.Form.Get("request"))
		return
	}
	if r.Header.Get("Origin") != o.origin {
		http.Error(w, "invalid origin", 403)
		return
	}
	if r.Form.Get("action") == "cancel" {
		if !loopbackURL(session.RedirectURL) || !strings.HasPrefix(session.RedirectURL, o.origin+"/") {
			http.Error(w, "invalid local return", 403)
			return
		}
		http.Redirect(w, r, session.RedirectURL, http.StatusSeeOther)
		return
	}
	if r.Form.Get("action") != "agree" {
		http.Error(w, "invalid action", 400)
		return
	}
	labMutex.Lock()
	defer labMutex.Unlock()
	if readLabJSON(path, &a) != nil || a.Used || !time.Now().Before(a.Expires) {
		http.Error(w, "authorization already used", 403)
		return
	}
	code := randomSecret()
	codePath, _ := o.path("code", code)
	if err = writeLabJSON(codePath, a); err != nil {
		http.Error(w, "authorization storage failed", 500)
		return
	}
	a.Used = true
	if writeLabJSON(path, a) != nil {
		http.Error(w, "authorization storage failed", 500)
		return
	}
	http.Redirect(w, r, o.origin+"/v1/alipay/oauth/callback?"+url.Values{"state": {a.State}, "auth_code": {code}}.Encode(), http.StatusSeeOther)
}
