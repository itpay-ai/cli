//go:build localux

package bootstrap

import (
	"github.com/itpay-ai/compose/services/backend/internal/ports"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalFixtureScoped(t *testing.T) {
	t.Setenv("ITPAY_LOCAL_UX_DIR", t.TempDir())
	path := filepath.Join(labDir(), "fixture-scenario.json")
	writeLabJSON(path, localFixtureScenario{Kind: "unknown_contract", ExecutionID: "se_fixture"})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"execution":{"public_binding":{"adapter_key":"rail.v1"}}}`))
	})
	if localFixtureFault(h, httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/service-executions/se_other", nil)) {
		t.Fatal("wrong execution affected")
	}
	w := httptest.NewRecorder()
	if !localFixtureFault(h, w, httptest.NewRequest("GET", "/v1/service-executions/se_fixture", nil)) || !strings.Contains(w.Body.String(), "local.fixture.unsupported") {
		t.Fatal("fixture not injected")
	}
	if localFixtureFault(h, httptest.NewRecorder(), httptest.NewRequest("GET", "/v1/service-executions/se_fixture", nil)) {
		t.Fatal("not one shot")
	}
}
func TestLocalContinuationResponseOnly(t *testing.T) {
	t.Setenv("ITPAY_LOCAL_UX_DIR", t.TempDir())
	writeLabJSON(filepath.Join(labDir(), "fixture-scenario.json"), localFixtureScenario{Kind: "omit_continuation_response", ExecutionID: "se_fixture"})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"booking_template":{"input_example":{"input":{"passengers":1},"continuation":{"service_execution_id":"se_fixture"}}}}`))
	})
	if localFixtureFault(h, httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/service-executions", strings.NewReader(`{"input":{}}`))) {
		t.Fatal("signed request altered")
	}
	w := httptest.NewRecorder()
	if !localFixtureFault(h, w, httptest.NewRequest("GET", "/v1/service-executions/se_fixture/rail-planning/journeys/jny_fixture", nil)) || strings.Contains(w.Body.String(), "continuation") || !strings.Contains(w.Body.String(), "passengers") {
		t.Fatal("response fixture scope")
	}
}
func TestLocalRefundSequenceBound(t *testing.T) {
	t.Setenv("ITPAY_LOCAL_UX_DIR", t.TempDir())
	writeLabJSON(filepath.Join(labDir(), "refund-scenario.json"), localRefundFixture{RefundRequestID: "rr_fixture", Statuses: []string{"pending", "unknown", "succeeded"}})
	r := ports.PaymentRefundRequest{RefundRequestID: "rr_other", ProviderTradeNo: "localux_test", AmountMinor: 200, Currency: "CNY"}
	if _, _, ok := localRefundSequence(r, false); ok {
		t.Fatal("other refund affected")
	}
	r.RefundRequestID = "rr_fixture"
	if v, e, ok := localRefundSequence(r, false); !ok || e != nil || v.Status != "pending" {
		t.Fatal("pending", e)
	}
	if _, e, ok := localRefundSequence(r, true); !ok || e == nil {
		t.Fatal("unknown not returned")
	}
	if v, e, ok := localRefundSequence(r, true); !ok || e != nil || v.Status != "succeeded" || v.AmountMinor != 200 {
		t.Fatal("success", e)
	}
	r.ProviderTradeNo = "live"
	if _, _, ok := localRefundSequence(r, false); ok {
		t.Fatal("live affected")
	}
}
