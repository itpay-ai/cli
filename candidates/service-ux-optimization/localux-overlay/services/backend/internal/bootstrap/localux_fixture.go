//go:build localux

package bootstrap

import (
	"encoding/json"
	"errors"
	invocation "github.com/itpay-ai/compose/services/backend/internal/domain/providerinvocation"
	"github.com/itpay-ai/compose/services/backend/internal/ports"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"time"
)

type localFixtureScenario struct {
	Kind        string
	OperationID string
	ExecutionID string
	Used        bool
}

// One explicitly scoped fixture request; preserves the real validators and store.
func localFixtureFault(next http.Handler, w http.ResponseWriter, r *http.Request) bool {
	path := filepath.Join(labDir(), "fixture-scenario.json")
	labMutex.Lock()
	var c localFixtureScenario
	if readLabJSON(path, &c) != nil || c.Used {
		labMutex.Unlock()
		return false
	}
	responseFault := r.Method == "GET" && strings.HasPrefix(c.ExecutionID, "se_") && ((c.Kind == "unknown_contract" && r.URL.Path == "/v1/service-executions/"+c.ExecutionID) || (c.Kind == "omit_continuation_response" && strings.HasPrefix(r.URL.Path, "/v1/service-executions/"+c.ExecutionID+"/rail-planning/journeys/")))
	if !responseFault {
		labMutex.Unlock()
		return false
	}

	c.Used = true
	if writeLabJSON(path, c) != nil {
		labMutex.Unlock()
		http.Error(w, "local fixture record failed", 500)
		return true
	}
	labMutex.Unlock()
	rec := httptest.NewRecorder()
	next.ServeHTTP(rec, r)
	var body map[string]any
	raw := rec.Body.Bytes()
	if rec.Code == 200 && json.Unmarshal(raw, &body) == nil {
		if c.Kind == "omit_continuation_response" {
			localOmitContinuation(body)
			raw, _ = json.Marshal(body)
		}
		if ex, ok := body["execution"].(map[string]any); ok && c.Kind == "unknown_contract" {
			if b, ok := ex["public_binding"].(map[string]any); ok {
				b["adapter_key"] = "local.fixture.unsupported"
				raw, _ = json.Marshal(body)
			}
		}
	}
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	w.Write(raw)
	return true
}

func localOmitContinuation(v any) {
	switch x := v.(type) {
	case map[string]any:
		delete(x, "continuation")
		for _, child := range x {
			localOmitContinuation(child)
		}
	case []any:
		for _, child := range x {
			localOmitContinuation(child)
		}
	}
}

type localRefundFixture struct {
	RefundRequestID string
	Statuses        []string
	Index           int
	Submitted       bool
	SubmitCalls     int
	QueryCalls      int
}

// Supplier-only states, bound to one real application refund ID. No DB writes.
func localRefundSequence(r ports.PaymentRefundRequest, query bool) (ports.PaymentRefundResult, error, bool) {
	if !strings.HasPrefix(r.ProviderTradeNo, "localux_") {
		return ports.PaymentRefundResult{}, nil, false
	}
	labMutex.Lock()
	defer labMutex.Unlock()
	path := filepath.Join(labDir(), "refund-scenario.json")
	var c localRefundFixture
	if readLabJSON(path, &c) != nil || c.RefundRequestID == "" || c.RefundRequestID != r.RefundRequestID || len(c.Statuses) == 0 {
		return ports.PaymentRefundResult{}, nil, false
	}
	for _, s := range c.Statuses {
		if s != "pending" && s != "unknown" && s != "succeeded" {
			return ports.PaymentRefundResult{}, errors.New("invalid local refund fixture"), true
		}
	}
	if query {
		c.QueryCalls++
		if c.Submitted && c.Index < len(c.Statuses)-1 {
			c.Index++
		}
	} else {
		c.SubmitCalls++
		c.Submitted = true
	}
	status := c.Statuses[c.Index]
	if writeLabJSON(path, c) != nil {
		return ports.PaymentRefundResult{}, errors.New("local fixture record failed"), true
	}
	v := ports.PaymentRefundResult{Provider: r.Provider, ProviderRefundID: "localux_" + r.RefundRequestID, ProviderStatus: strings.ToUpper(status), Status: status, EvidenceHash: "localux:" + r.RefundRequestID + ":" + time.Now().UTC().Format(time.RFC3339Nano), AmountMinor: r.AmountMinor, Currency: r.Currency}
	if status == "unknown" {
		return v, invocation.OutcomeUnknownError{Err: errors.New("controlled local refund outcome unknown"), Code: "local_fixture_refund_unknown"}, true
	}
	if e := writeLabJSON(filepath.Join(labDir(), "refunds", r.RefundRequestID+".json"), v); e != nil {
		return ports.PaymentRefundResult{}, e, true
	}
	return v, nil, true
}
