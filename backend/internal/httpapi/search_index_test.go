package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The search index is the one query endpoint /ui/search loads; the server
// flattens every entity into rows the client filters.

func searchIndexOf(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode search index: %v", err)
	}
	return out
}

func TestSearchIndexCoversAllEntityTypes(t *testing.T) {
	h, _, _ := newTestServer(t)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/versions/current/search-index", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	entries := searchIndexOf(t, rec.Body.Bytes())

	byType := map[string][]map[string]any{}
	for _, e := range entries {
		byType[e["type"].(string)] = append(byType[e["type"].(string)], e)
	}
	for _, typ := range []string{"device", "link", "network", "subnet", "rule"} {
		if len(byType[typ]) == 0 {
			t.Errorf("no %q entries in index", typ)
		}
	}

	// Subnet entries carry their CIDR so IP/CIDR queries match semantically.
	if got := byType["subnet"][0]["prefixes"].([]any); len(got) != 1 {
		t.Errorf("subnet prefixes = %v, want one CIDR", got)
	}
}

func TestSearchIndexResolvesMemberSubnetCIDRs(t *testing.T) {
	h, _, _ := newTestServer(t)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/versions/current/search-index", nil))
	entries := searchIndexOf(t, rec.Body.Bytes())

	for _, e := range entries {
		if e["type"] == "network" && e["name"] == "n-office" {
			prefixes := e["prefixes"].([]any)
			if len(prefixes) != 1 || prefixes[0] != "10.0.0.0/24" {
				t.Errorf("n-office prefixes = %v, want [10.0.0.0/24]", prefixes)
			}
			return
		}
	}
	t.Fatal("n-office entry not found in index")
}

func TestDraftSearchIndexReflectsDraftEdits(t *testing.T) {
	h, _, draftID := newTestServer(t)

	// Read the draft's subnets and add a new one; the draft index must
	// reflect the edit. (A rename of any fixture subnet is blocked with
	// 409 — both are referenced by n-office/n-dmz and the seed rule — so
	// the edit is an addition, which no deletion guard rejects.)
	get := doJSON(t, h, http.MethodGet, draftPath(draftID, "subnets"), nil)
	var subnets SubnetsDoc
	if err := json.Unmarshal(get.Body.Bytes(), &subnets); err != nil {
		t.Fatalf("decode draft subnets: %v", err)
	}
	subnets.Subnets = append(subnets.Subnets, SubnetDoc{Name: "hq-lan", CIDR: "10.0.9.0/24"})
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), subnets); rec.Code != http.StatusOK {
		t.Fatalf("put draft subnets: status %d, body %s", rec.Code, rec.Body.String())
	}

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "search-index"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("draft index status %d: %s", rec.Code, rec.Body.String())
	}
	for _, e := range searchIndexOf(t, rec.Body.Bytes()) {
		if e["type"] == "subnet" && e["name"] == "hq-lan" {
			return
		}
	}
	t.Fatal("renamed subnet missing from draft index")
}
