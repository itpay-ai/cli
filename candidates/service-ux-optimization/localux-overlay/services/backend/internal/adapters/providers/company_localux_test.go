//go:build localux

package providers

import "testing"

func TestLocalCompanyIsolation(t *testing.T) {
	for _, op := range []map[string]any{{"base_url": "https://evil.example", "path_template": "/getCompanyBaseInfo/{company_name}/"}, {"base_url": "https://api.81api.com", "path_template": "/unknown"}, {"base_url": "https://api.81api.com", "path_template": "/getCompanyBaseInfo/{company_name}/", "method": "POST"}} {
		if _, e := localHTTPOperation(op); e == nil {
			t.Fatal("unlisted operation permitted")
		}
	}
	op, e := localHTTPOperation(map[string]any{"base_url": "https://api.81api.com", "path_template": "/getCompanyBaseInfo/{company_name}/"})
	if e != nil || op["base_url"] != "http://127.0.0.1:18766" {
		t.Fatal("not isolated", e)
	}
	if !blockLiveTransaction() {
		t.Fatal("live payment permitted")
	}
}
