package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/lint"
	"github.com/kudes1/firenet/internal/rules"
)

const fixtureTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const fixtureSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
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
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	if err := users.BootstrapAdmin(context.Background(), "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}

	dir := t.TempDir()
	store := FileProjectStore{
		TopologyPath: filepath.Join(dir, "topology.yaml"),
		SubnetsPath:  filepath.Join(dir, "subnets.yaml"),
		RulesPath:    filepath.Join(dir, "rules.yaml"),
		LayoutPath:   filepath.Join(dir, ".firenet-layout.json"),
	}
	if err := store.WriteTopology([]byte(fixtureTopology)); err != nil {
		t.Fatalf("seed topology: %v", err)
	}
	if err := store.WriteSubnets([]byte(fixtureSubnets)); err != nil {
		t.Fatalf("seed subnets: %v", err)
	}
	if err := store.WriteRules([]byte(fixtureRules)); err != nil {
		t.Fatalf("seed rules: %v", err)
	}

	srv := NewServer(store, users, discardLogger())
	return authenticatedHandler(t, srv), store
}

// authenticatedHandler logs in once and returns a handler that stamps
// every incoming test request with that session cookie first, so the
// dozens of existing handler tests that build requests directly and call
// srv.ServeHTTP need no changes to stay authenticated.
func authenticatedHandler(t *testing.T, srv http.Handler) http.Handler {
	t.Helper()
	body, err := json.Marshal(loginRequest{Username: "admin", Password: "test-password-1"})
	if err != nil {
		t.Fatalf("marshal login body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test login failed: status %d, body %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("test login did not set a session cookie")
	}
	sessionCookie := cookies[0]

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(sessionCookie)
		srv.ServeHTTP(w, r)
	})
}

// errorBody decodes the {"error": ...} envelope into the raw message.
func errorBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return out.Error
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
	if len(doc.Devices) != 2 || len(doc.Networks) != 2 {
		t.Fatalf("unexpected doc: %+v", doc)
	}
}

func TestGetPutSubnets(t *testing.T) {
	h, _ := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, "/api/subnets", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var doc SubnetsDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(doc.Subnets) != 2 {
		t.Fatalf("unexpected subnets: %+v", doc)
	}

	doc.Subnets = append(doc.Subnets, SubnetDoc{Name: "guest", CIDR: "10.0.2.0/24"})
	rec = doJSON(t, h, http.MethodPut, "/api/subnets", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestGetPutTopologyWithUnions(t *testing.T) {
	h, store := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, "/api/topology", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Unions) != 0 {
		t.Fatalf("expected empty unions on fixture, got %+v", got.Unions)
	}

	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links:    []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}}},
		Sets:     []SetDoc{},
		Unions:   []UnionDoc{{Name: "office", Devices: []string{"r1", "r2"}, Networks: []string{"n-office"}, Description: "hq"}},
	}
	rec = doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	raw, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read stored: %v", err)
	}
	var stored TopologyDoc
	if err := yaml.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("parse stored: %v", err)
	}
	if len(stored.Unions) != 1 || stored.Unions[0].Name != "office" || len(stored.Unions[0].Devices) != 2 {
		t.Fatalf("unexpected stored unions: %+v", stored.Unions)
	}

	// битая ссылка отклоняется
	doc.Unions[0].Devices = []string{"ghost"}
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown union member: status = %d, body = %s", rec.Code, rec.Body)
	}

	// двойное членство отклоняется
	doc.Unions[0].Devices = []string{"r1"}
	doc.Unions = append(doc.Unions, UnionDoc{Name: "second", Devices: []string{"r1"}})
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("double membership: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestDeletionGuardBlocksDeviceInUnion(t *testing.T) {
	h, _ := newTestServer(t)
	base := func(devices []DeviceDoc, unions []UnionDoc) TopologyDoc {
		return TopologyDoc{
			Devices: devices,
			Links:   []LinkDoc{},
			Networks: []NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
			},
			Sets:   []SetDoc{},
			Unions: unions,
		}
	}
	all := base(
		[]DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}, {Name: "r3", Kind: "router"}},
		[]UnionDoc{{Name: "office", Devices: []string{"r3"}}},
	)
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", all); rec.Code != http.StatusOK {
		t.Fatalf("seed status = %d, body = %s", rec.Code, rec.Body)
	}
	// r3 ссылается только сайт — удаление блокируется с 409
	shrink := base(all.Devices[:2], []UnionDoc{{Name: "office", Devices: []string{"r3"}}})
	rec := doJSON(t, h, http.MethodPut, "/api/topology", shrink)
	if rec.Code != http.StatusConflict {
		t.Fatalf("device in union: status = %d, body = %s", rec.Code, rec.Body)
	}
	if msg := errorBody(t, rec); !strings.Contains(msg, `union "office"`) {
		t.Fatalf("want union dependency in error, got %s", msg)
	}
}

func TestPutSubnets_DescriptionRoundTrip(t *testing.T) {
	h, store := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24", Description: "офисный сегмент"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
	}}
	rec := doJSON(t, h, http.MethodPut, "/api/subnets", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, "/api/subnets", nil)
	var got SubnetsDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Subnets[0].Description != "офисный сегмент" {
		t.Fatalf("description lost: %+v", got.Subnets[0])
	}
	if got.Subnets[1].Description != "" {
		t.Fatalf("unexpected description: %+v", got.Subnets[1])
	}
	raw, err := store.ReadSubnets()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	dmzStart := bytes.Index(raw, []byte("name: dmz"))
	next := bytes.IndexByte(raw[dmzStart:], '\n')
	if bytes.Contains(raw[dmzStart:dmzStart+next], []byte("description")) {
		t.Fatalf("empty description must not be stored: %s", raw)
	}
}

func TestPutSubnets_RejectsOverlap(t *testing.T) {
	h, _ := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.0.128/25"},
	}}
	rec := doJSON(t, h, http.MethodPut, "/api/subnets", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutSubnets_RejectsDeletingUsedSubnet(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadSubnets()
	doc := SubnetsDoc{Subnets: []SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}}
	rec := doJSON(t, h, http.MethodPut, "/api/subnets", doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (dmz still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`subnet "dmz"`, `network "n-dmz"`, `rule "office-to-dmz"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after, _ := store.ReadSubnets()
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutSubnets_AllowsDeletingUnusedSubnet(t *testing.T) {
	h, _ := newTestServer(t)
	withGuest := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
		{Name: "guest", CIDR: "10.0.2.0/24"},
	}}
	if rec := doJSON(t, h, http.MethodPut, "/api/subnets", withGuest); rec.Code != http.StatusOK {
		t.Fatalf("add guest: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, "/api/subnets", SubnetsDoc{Subnets: withGuest.Subnets[:2]})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete guest: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsDeletingUsedDevice(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadTopology()
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r2", Kind: "router"}}, // r1 removed, its link/attach kept
		Links:   []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (r1 still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`device "r1"`, `link[0]`, `network "n-office"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after, _ := store.ReadTopology()
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutTopology_AllowsDeletingFreeDevice(t *testing.T) {
	h, _ := newTestServer(t)
	base := func(devices []DeviceDoc) TopologyDoc {
		return TopologyDoc{
			Devices: devices,
			Links:   []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
			Networks: []NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
			},
		}
	}
	all := append([]DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}}, DeviceDoc{Name: "sw1", Kind: "switch"})
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", base(all)); rec.Code != http.StatusOK {
		t.Fatalf("add sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", base(all[:2]))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsUnknownSubnetInNetwork(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"ghost"}}},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_Valid(t *testing.T) {
	h, store := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
		},
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
			{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r1"}},
		},
		Networks: []NetworkDoc{},
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

func TestPutTopology_SetRoundTrip(t *testing.T) {
	h, store := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
		},
		Sets: []SetDoc{
			{Name: "blocked", Subnets: []string{"office"}, Addresses: []string{"10.0.0.9"}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	raw, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var stored TopologyDoc
	if err := yaml.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("unmarshal stored topology: %v", err)
	}
	if len(stored.Sets) != 1 || stored.Sets[0].Name != "blocked" || len(stored.Sets[0].Addresses) != 1 || stored.Sets[0].Addresses[0] != "10.0.0.9" {
		t.Fatalf("stored sets = %+v", stored.Sets)
	}
}

func TestPutTopology_DescriptionRoundTrip(t *testing.T) {
	h, store := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}, Description: "офисная сеть"},
		},
		Sets: []SetDoc{{Name: "blocked", Subnets: []string{"office"}, Description: "блоклист"}},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	raw, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	var stored TopologyDoc
	if err := yaml.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("unmarshal stored topology: %v", err)
	}
	if stored.Networks[0].Description != "офисная сеть" {
		t.Fatalf("network description lost: %+v", stored.Networks[0])
	}
	if stored.Sets[0].Description != "блоклист" {
		t.Fatalf("set description lost: %+v", stored.Sets[0])
	}

	rec = doJSON(t, h, http.MethodGet, "/api/topology", nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Networks[0].Description != "офисная сеть" || got.Sets[0].Description != "блоклист" {
		t.Fatalf("descriptions lost over GET: %+v %+v", got.Networks[0], got.Sets[0])
	}
}

func TestPutTopology_RejectsSetAddressOutsideSubnets(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"office"}}},
		Sets:     []SetDoc{{Name: "bad", Addresses: []string{"192.168.5.5"}}},
	}
	rec := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutRules_RejectsUnknownEndpoint(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadRules()

	doc := PolicyDoc{Chains: []ChainDoc{{
		DefaultAction: "deny",
		Rules: []RuleDoc{
			{Name: "bad", Src: []string{"office"}, Dst: []string{"does-not-exist"}, Action: "allow"},
		},
	}}}
	rec := doJSON(t, h, http.MethodPut, "/api/rules", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after, _ := store.ReadRules()
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestGetRulesNormalizesLegacyFile(t *testing.T) {
	h, store := newTestServer(t)
	if err := store.WriteRules([]byte("defaultAction: deny\nchainName: OLD\nrules: []\n")); err != nil {
		t.Fatal(err)
	}
	rec := doJSON(t, h, http.MethodGet, "/api/rules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var doc PolicyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Chains) != 1 || doc.Chains[0].Name != "OLD" {
		t.Fatalf("normalized doc = %+v", doc)
	}
}

func TestPutRules_RejectsUnknownJumpTarget(t *testing.T) {
	h, store := newTestServer(t)
	before, _ := store.ReadRules()
	doc := PolicyDoc{Chains: []ChainDoc{{
		Name: "FIRENET-FWD", DefaultAction: "deny",
		Rules: []RuleDoc{{Name: "r", Src: []string{"any"}, Dst: []string{"any"}, Action: "jump", JumpTo: "GHOST"}},
	}}}
	rec := doJSON(t, h, http.MethodPut, "/api/rules", doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
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

func TestPutTopology_LinkFilterRoundTrip(t *testing.T) {
	h, store := newTestServer(t)

	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
		}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	if rec := doJSON(t, h, http.MethodPut, "/api/topology", doc); rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec := doJSON(t, h, http.MethodGet, "/api/topology", nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	if got.Links[0].Filter == nil ||
		!slices.Equal(got.Links[0].Filter.AExports, []string{"n-office"}) ||
		!slices.Equal(got.Links[0].Filter.BExports, []string{"n-dmz"}) {
		t.Fatalf("filter did not survive round-trip: %+v", got.Links[0])
	}

	stored, err := store.ReadTopology()
	if err != nil {
		t.Fatalf("read stored topology: %v", err)
	}
	if !strings.Contains(string(stored), "a-exports") {
		t.Fatalf("stored yaml missing a-exports:\n%s", stored)
	}
}

func TestPutTopology_RejectsFilteredLinkWithSwitch(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}, {Name: "sw", Kind: "switch"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "sw"},
			Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
		}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	res := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "two routers") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestPutTopology_RejectsUnknownExport(t *testing.T) {
	h, _ := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"ghost"}, BExports: []string{"n2"}},
		}},
	}
	res := doJSON(t, h, http.MethodPut, "/api/topology", doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "unknown export entity") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestGetLinkExports(t *testing.T) {
	h, _ := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, "/api/link-exports?link=0&side=a", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// The edited link itself is excluded from the graph: from r1 only its
	// own network stays in reach.
	want := []EntityDoc{{Name: "n-office"}, {Name: "office", CIDR: "10.0.0.0/24"}}
	if !slices.EqualFunc(got.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", got.Entities, want)
	}

	for _, q := range []string{"link=0&side=c", "link=x&side=a", "link=-1&side=a"} {
		if rec := doJSON(t, h, http.MethodGet, "/api/link-exports?"+q, nil); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: want 422, got %d", q, rec.Code)
		}
	}
	if rec := doJSON(t, h, http.MethodGet, "/api/link-exports?link=7&side=a", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("out-of-range link: want 404, got %d", rec.Code)
	}
}

func TestDiagnoseHandler(t *testing.T) {
	h, _ := newTestServer(t)

	t.Run("allowed flow reports matched rule", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose",
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var rep diagnose.Report
		if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" || len(rep.Paths) != 1 {
			t.Fatalf("unexpected report: %+v", rep)
		}
		if rep.Paths[0].Verdict != rules.ActionAllow || rep.Paths[0].Routers[0].MatchedRule != "office-to-dmz" {
			t.Fatalf("unexpected verdict: %+v", rep.Paths[0])
		}
		if !strings.Contains(rec.Body.String(), `"kind":1,"name":"office"`) {
			t.Fatalf("path nodes must serialize with lowercase keys, got %s", rec.Body.String())
		}
	})

	t.Run("invalid IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose", map[string]any{"src": "nonsense", "dst": "10.0.1.7"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "src") {
			t.Fatalf("error should mention src, got %q", msg)
		}
	})

	t.Run("unknown IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose", map[string]any{"src": "10.0.0.5", "dst": "192.168.99.99"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "не принадлежит") {
			t.Fatalf("error should explain unknown IP, got %q", msg)
		}
	})

	t.Run("bad proto is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose", map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "sctp"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
	})

	t.Run("invalid port string is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose",
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"abc"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, `"abc"`) {
			t.Fatalf("error should mention the bad port, got %q", msg)
		}
	})

	t.Run("inverted port range is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose",
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "srcPorts": []string{"2000:1000"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("valid port range passes validation", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/api/diagnose",
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443", "1024:65535"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestLintEndpoint(t *testing.T) {
	h, store := newTestServer(t)

	t.Run("clean policy has no findings", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Findings []lint.Finding `json:"findings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(out.Findings) != 0 {
			t.Fatalf("want no findings for the default fixture, got %+v", out.Findings)
		}
	})

	t.Run("unreachable rule is reported", func(t *testing.T) {
		if err := store.WriteRules([]byte(`
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`)); err != nil {
			t.Fatal(err)
		}
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Findings []lint.Finding `json:"findings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Findings) != 1 || out.Findings[0].Chain != "FIRENET-FWD" {
			t.Fatalf("want one unreachable-rule finding, got %+v", out.Findings)
		}
	})

	t.Run("invalid rules file surfaces as client error", func(t *testing.T) {
		if err := store.WriteRules([]byte(`
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: bad, src: [no-such-subnet], dst: [any], proto: any, action: allow}
`)); err != nil {
			t.Fatal(err)
		}
		rec := doJSON(t, h, http.MethodGet, "/api/lint", nil)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}
