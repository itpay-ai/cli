//go:build localux

package providers

import (
	"encoding/json"
	invocation "github.com/itpay-ai/compose/services/backend/internal/domain/providerinvocation"
	"github.com/itpay-ai/compose/services/backend/internal/ports"
	"os"
	"path/filepath"
	"sync"
)

// All callers, including accidentally unwired ones, fail before transport.
func blockLiveTransaction() bool { return true }
func localHTTPOperation(op map[string]any) (map[string]any, error) {
	// Exact company publication endpoints redirect only to a loopback fixture.
	if op["base_url"] == "https://api.81api.com" || op["base_url"] == "http://api.81api.com" {
		path, _ := op["path_template"].(string)
		switch path {
		case "/fuzzySuggestCompanyName/{keyword}/", "/getCompanyBaseInfo/{company_name}/", "/getCompanyBranchInfo/{company_name}/", "/getCompanyAbnormalInfo/{company_name}/", "/getCompanyJudicialCaseseriesInfo/{company_name}/", "/getCompanyDishonestInfo/{company_name}/", "/getCompanyJudgmentDebtorInfo/{company_name}/", "/getCompanyCourtInfo/{company_name}/", "/getCompanyLawsuitInfo/{company_name}/", "/getCompanyFinancingInfo/{company_name}/", "/getCompanyInvestEventsInfo/{company_name}/", "/getCompanyJobsInfo/{company_name}/":
		default:
			return nil, ErrTengyunInvalidRequest
		}
		if m, ok := op["method"].(string); ok && m != "" && m != "GET" {
			return nil, ErrTengyunInvalidRequest
		}
		copy := map[string]any{}
		for k, v := range op {
			copy[k] = v
		}
		copy["base_url"] = "http://127.0.0.1:18766"
		copy["allowed_hosts"] = []any{"127.0.0.1"}
		copy["allow_insecure_test_http"] = true
		copy["auth"] = map[string]any{}
		return copy, nil
	}
	if op["base_url"] != "https://dev.itpay.ai/rail-provider" || op["side_effect"] != "read_only" {
		return nil, ErrTengyunInvalidRequest
	}
	path, _ := op["path_template"].(string)
	switch path {
	case "/v1/search", "/v1/geo", "/v1/catalog", "/v1/recommend", "/v1/quote":
	default:
		return nil, ErrTengyunInvalidRequest
	}
	copy := map[string]any{}
	for k, v := range op {
		copy[k] = v
	}
	copy["base_url"] = "http://127.0.0.1:18765"
	copy["path_template"] = "/internal" + path
	copy["allowed_hosts"] = []any{"127.0.0.1"}
	copy["allow_insecure_test_http"] = true
	return copy, nil
}

var quoteFaultMutex sync.Mutex

func localHTTPFault(r ports.ServiceProviderAdapterRequest, op map[string]any) error {
	if op["path_template"] != "/v1/quote" {
		return nil
	}
	quoteFaultMutex.Lock()
	defer quoteFaultMutex.Unlock()
	path := filepath.Join(os.Getenv("ITPAY_LOCAL_UX_DIR"), "scenario.json")
	raw, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var scenario struct {
		ExecutionID string `json:"execution_id"`
		Mode        string `json:"mode"`
		Used        bool   `json:"used"`
	}
	if e = json.Unmarshal(raw, &scenario); e != nil {
		return e
	}
	if scenario.ExecutionID != r.TrustedExecutionID || scenario.Mode != "quote_transient" || scenario.Used {
		return nil
	}
	scenario.Used = true
	raw, _ = json.Marshal(scenario)
	if e = os.WriteFile(path, raw, 0600); e != nil {
		return e
	}
	leg := 0
	return invocation.RejectedError{Code: "provider_unavailable", Message: "controlled local quote fault (one shot)", Temporary: true, AffectedLeg: &leg}
}
