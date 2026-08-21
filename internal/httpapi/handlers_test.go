package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

const fixtureTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1, interface: wan0}, b: {device: r2, interface: wan0}}
subnets:
  - {name: office, cidr: 10.0.0.0/24, attach: [{device: r1, interface: lan0}]}
  - {name: dmz, cidr: 10.0.1.0/24, attach: [{device: r2, interface: lan0}]}
zones: []
`

const fixtureRules = `
defaultAction: deny
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestServer(t *testing.T) (http.Handler, FileProjectStore) {
	t.Helper()
	dir := t.TempDir()
	store := FileProjectStore{
		TopologyPath: filepath.Join(dir, "topology.yaml"),
		RulesPath:    filepath.Join(dir, "rules.yaml"),
		LayoutPath:   filepath.Join(dir, ".firenet-layout.json"),
	}
	if err := store.WriteTopology([]byte(fixtureTopology)); err != nil {
		t.Fatalf("seed topology: %v", err)
	}
	if err := store.WriteRules([]byte(fixtureRules)); err != nil {
		t.Fatalf("seed rules: %v", err)
	}
	return NewServer(store, discardLogger()), store
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGetTopology(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, "/api/topology", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var doc TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(doc.Devices) != 2 || len(doc.Subnets) != 2 {
		t.Fatalf("unexpected doc: %+v", doc)
	}
}

func TestPutTopology_Valid(t *testing.T) {
	h, store := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Subnets: []SubnetDoc{},
		Zones:   []ZoneDoc{},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	raw, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Contains(raw, []byte("r1")) {
		t.Fatalf("stored topology missing device: %s", raw)
	}
}

func TestPutTopology_RejectsSelfLoopLink(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadTopology()

	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links: []LinkDoc{
			{A: EndpointDoc{Device: "r1", Interface: "a0"}, B: EndpointDoc{Device: "r1", Interface: "a0"}},
		},
		Subnets: []SubnetDoc{},
		Zones:   []ZoneDoc{},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
		t.Fatalf("expected rejection, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after, _ := store.ReadTopology()
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid topology must not be persisted")
	}
}

func TestPutRules_RejectsUnknownEndpoint(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadRules()

	doc := PolicyDoc{
		DefaultAction: "deny",
		Rules: []RuleDoc{
			{Name: "bad", Src: []string{"office"}, Dst: []string{"does-not-exist"}, Action: "allow"},
		},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/rules", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after, _ := store.ReadRules()
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestValidateEndpoint(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, "/api/validate", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var out struct {
		Valid  bool     `json:"valid"`
		Errors []string `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.Valid {
		t.Fatalf("expected valid fixture, got errors: %v", out.Errors)
	}
}

func TestCompileEndpoint(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, "/api/compile", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var devices []struct {
		Name         string
		IPSetsScript string
		RulesScript  string
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &devices); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(devices))
	}
	for _, d := range devices {
		if d.RulesScript == "" || d.IPSetsScript == "" {
			t.Fatalf("%s: empty scripts", d.Name)
		}
	}
}

func TestLayoutRoundTrip(t *testing.T) {
	h, _ := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, "/api/layout", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "{}" {
		t.Fatalf("expected empty layout, got status = %d, body = %s", rec.Code, rec.Body)
	}

	layout := map[string]any{"devices": map[string]any{"r1": map[string]float64{"x": 1, "y": 2}}}
	rec = doJSON(t, h, http.MethodPut, "/api/layout", layout)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, "/api/layout", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"r1"`)) {
		t.Fatalf("layout not persisted: %s", rec.Body)
	}
}
