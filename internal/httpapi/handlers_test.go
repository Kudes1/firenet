package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/lint"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
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

// mustParseFixtureDoc builds the ProjectDoc newTestServer seeds as
// version 1, from the same YAML fixtures the file used to write directly
// to disk.
func mustParseFixtureDoc(t *testing.T) projectdoc.ProjectDoc {
	t.Helper()
	var doc projectdoc.ProjectDoc
	if err := yaml.Unmarshal([]byte(fixtureTopology), &doc.Topology); err != nil {
		t.Fatalf("parse fixture topology: %v", err)
	}
	if err := yaml.Unmarshal([]byte(fixtureSubnets), &doc.Subnets); err != nil {
		t.Fatalf("parse fixture subnets: %v", err)
	}
	pol, err := rules.Load(strings.NewReader(fixtureRules))
	if err != nil {
		t.Fatalf("parse fixture rules: %v", err)
	}
	doc.Rules = NewPolicyDoc(pol)
	return doc
}

// newTestServer seeds version 1 from the fixtures above and opens one
// draft ("test-draft") on top of it, owned by the bootstrapped admin.
// Returns the authenticated handler, the pgstore.Store for tests that
// need to inspect persisted state directly, and the draft's id.
func newTestServer(t *testing.T) (http.Handler, *pgstore.Store, string) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	ctx := context.Background()
	if err := users.BootstrapAdmin(ctx, "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}
	admin, err := users.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("get admin: %v", err)
	}

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, mustParseFixtureDoc(t), admin); err != nil {
		t.Fatalf("seed initial version: %v", err)
	}
	draft, err := projects.CreateDraft(ctx, admin, "test-draft")
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	srv := NewServer(projects, users, discardLogger())
	return authenticatedHandler(t, srv), projects, draft.ID
}

// authenticatedHandler logs in once and returns a handler that stamps
// every incoming test request with that session cookie first, so tests
// that build requests directly and call srv.ServeHTTP need no changes to
// stay authenticated.
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

// draftPath builds a /api/drafts/{id}/... URL.
func draftPath(draftID, suffix string) string {
	return "/api/drafts/" + draftID + "/" + suffix
}

// readDraftDoc fetches a draft's current document straight from the
// store, bypassing HTTP — used where a test used to inspect the file
// store directly.
func readDraftDoc(t *testing.T, projects *pgstore.Store, draftID string) projectdoc.ProjectDoc {
	t.Helper()
	doc, _, err := projects.ReadDraft(context.Background(), draftID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	return doc
}

func marshalJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// doJSON issues a request with an optional JSON body against h. A PUT to
// a /api/drafts/{id}/... path first GETs that same path to pick up the
// fresh X-Draft-Revision, so individual tests never have to manage CAS
// revisions themselves.
func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var revision string
	if method == http.MethodPut && strings.Contains(path, "/api/drafts/") {
		getRec := httptest.NewRecorder()
		h.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, path, nil))
		revision = getRec.Result().Header.Get("X-Draft-Revision")
	}

	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	if revision != "" {
		req.Header.Set("X-Draft-Revision", revision)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGetTopology(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
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
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "subnets"), nil)
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
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestGetPutTopologyWithUnions(t *testing.T) {
	h, projects, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
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
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	stored := readDraftDoc(t, projects, draftID).Topology
	if len(stored.Unions) != 1 || stored.Unions[0].Name != "office" || len(stored.Unions[0].Devices) != 2 {
		t.Fatalf("unexpected stored unions: %+v", stored.Unions)
	}

	// битая ссылка отклоняется
	doc.Unions[0].Devices = []string{"ghost"}
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown union member: status = %d, body = %s", rec.Code, rec.Body)
	}

	// двойное членство отклоняется
	doc.Unions[0].Devices = []string{"r1"}
	doc.Unions = append(doc.Unions, UnionDoc{Name: "second", Devices: []string{"r1"}})
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("double membership: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestDeletionGuardBlocksDeviceInUnion(t *testing.T) {
	h, _, draftID := newTestServer(t)
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
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), all); rec.Code != http.StatusOK {
		t.Fatalf("seed status = %d, body = %s", rec.Code, rec.Body)
	}
	// r3 ссылается только сайт — удаление блокируется с 409
	shrink := base(all.Devices[:2], []UnionDoc{{Name: "office", Devices: []string{"r3"}}})
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), shrink)
	if rec.Code != http.StatusConflict {
		t.Fatalf("device in union: status = %d, body = %s", rec.Code, rec.Body)
	}
	if msg := errorBody(t, rec); !strings.Contains(msg, `union "office"`) {
		t.Fatalf("want union dependency in error, got %s", msg)
	}
}

func TestPutSubnets_DescriptionRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24", Description: "офисный сегмент"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
	}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "subnets"), nil)
	var got SubnetsDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// pgstore reconstructs subnets sorted by name (dmz, office), not
	// submission order — look up by name rather than assuming position.
	byName := map[string]SubnetDoc{}
	for _, s := range got.Subnets {
		byName[s.Name] = s
	}
	if byName["office"].Description != "офисный сегмент" {
		t.Fatalf("description lost: %+v", byName["office"])
	}
	if byName["dmz"].Description != "" {
		t.Fatalf("unexpected description: %+v", byName["dmz"])
	}
}

func TestPutSubnets_RejectsOverlap(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.0.128/25"},
	}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutSubnets_RejectsDeletingUsedSubnet(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Subnets)
	doc := SubnetsDoc{Subnets: []SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (dmz still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`subnet "dmz"`, `network "n-dmz"`, `rule "office-to-dmz"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Subnets)
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutSubnets_AllowsDeletingUnusedSubnet(t *testing.T) {
	h, _, draftID := newTestServer(t)
	withGuest := SubnetsDoc{Subnets: []SubnetDoc{
		{Name: "office", CIDR: "10.0.0.0/24"},
		{Name: "dmz", CIDR: "10.0.1.0/24"},
		{Name: "guest", CIDR: "10.0.2.0/24"},
	}}
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), withGuest); rec.Code != http.StatusOK {
		t.Fatalf("add guest: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "subnets"), SubnetsDoc{Subnets: withGuest.Subnets[:2]})
	if rec.Code != http.StatusOK {
		t.Fatalf("delete guest: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsDeletingUsedDevice(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r2", Kind: "router"}}, // r1 removed, its link/attach kept
		Links:   []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 (r1 still referenced), got status = %d, body = %s", rec.Code, rec.Body)
	}
	msg := errorBody(t, rec)
	for _, want := range []string{`device "r1"`, `link[0]`, `network "n-office"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q must mention %s", msg, want)
		}
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected document must not be persisted")
	}
}

func TestPutTopology_AllowsDeletingFreeDevice(t *testing.T) {
	h, _, draftID := newTestServer(t)
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
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), base(all)); rec.Code != http.StatusOK {
		t.Fatalf("add sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), base(all[:2]))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete sw1: status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_RejectsUnknownSubnetInNetwork(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"ghost"}}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutTopology_Valid(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
		},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	found := false
	for _, d := range stored.Devices {
		if d.Name == "r1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stored topology missing device r1: %+v", stored.Devices)
	}
}

func TestPutTopology_RejectsSelfLoopLink(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)

	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links: []LinkDoc{
			{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r1"}},
		},
		Networks: []NetworkDoc{},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
		t.Fatalf("expected rejection, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid topology must not be persisted")
	}
}

func TestPutTopology_SetRoundTrip(t *testing.T) {
	h, projects, draftID := newTestServer(t)
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
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	if len(stored.Sets) != 1 || stored.Sets[0].Name != "blocked" || len(stored.Sets[0].Addresses) != 1 || stored.Sets[0].Addresses[0] != "10.0.0.9" {
		t.Fatalf("stored sets = %+v", stored.Sets)
	}
}

func TestPutTopology_DescriptionRoundTrip(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:   []LinkDoc{},
		Networks: []NetworkDoc{
			{Name: "n1", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}, Description: "офисная сеть"},
		},
		Sets: []SetDoc{{Name: "blocked", Subnets: []string{"office"}, Description: "блоклист"}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	stored := readDraftDoc(t, projects, draftID).Topology
	if stored.Networks[0].Description != "офисная сеть" {
		t.Fatalf("network description lost: %+v", stored.Networks[0])
	}
	if stored.Sets[0].Description != "блоклист" {
		t.Fatalf("set description lost: %+v", stored.Sets[0])
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Networks[0].Description != "офисная сеть" || got.Sets[0].Description != "блоклист" {
		t.Fatalf("descriptions lost over GET: %+v %+v", got.Networks[0], got.Sets[0])
	}
}

func TestPutTopology_RejectsSetAddressOutsideSubnets(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices:  []DeviceDoc{{Name: "r1", Kind: "router"}},
		Links:    []LinkDoc{},
		Networks: []NetworkDoc{{Name: "n1", Subnets: []string{"office"}}},
		Sets:     []SetDoc{{Name: "bad", Addresses: []string{"192.168.5.5"}}},
	}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPutRules_RejectsUnknownEndpoint(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)

	doc := PolicyDoc{Chains: []ChainDoc{{
		DefaultAction: "deny",
		Rules: []RuleDoc{
			{Name: "bad", Src: []string{"office"}, Dst: []string{"does-not-exist"}, Action: "allow"},
		},
	}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "rules"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got status = %d, body = %s", rec.Code, rec.Body)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestPutRules_RejectsUnknownJumpTarget(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	doc := PolicyDoc{Chains: []ChainDoc{{
		Name: "FIRENET-FWD", DefaultAction: "deny",
		Rules: []RuleDoc{{Name: "r", Src: []string{"any"}, Dst: []string{"any"}, Action: "jump", JumpTo: "GHOST"}},
	}}}
	rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "rules"), doc)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422", rec.Code)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Rules)
	if !bytes.Equal(before, after) {
		t.Fatalf("invalid rules must not be persisted")
	}
}

func TestValidateEndpoint(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "validate"), nil)
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
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "compile"), nil)
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
	h, _, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "layout"), nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "{}" {
		t.Fatalf("expected empty layout, got status = %d, body = %s", rec.Code, rec.Body)
	}

	layout := map[string]any{"devices": map[string]any{"r1": map[string]float64{"x": 1, "y": 2}}}
	rec = doJSON(t, h, http.MethodPut, draftPath(draftID, "layout"), layout)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "layout"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"r1"`)) {
		t.Fatalf("layout not persisted: %s", rec.Body)
	}
}

func TestPutTopology_LinkFilterRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)

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
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc); rec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", rec.Code, rec.Body)
	}

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	var got TopologyDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	if got.Links[0].Filter == nil ||
		!slices.Equal(got.Links[0].Filter.AExports, []string{"n-office"}) ||
		!slices.Equal(got.Links[0].Filter.BExports, []string{"n-dmz"}) {
		t.Fatalf("filter did not survive round-trip: %+v", got.Links[0])
	}
}

func TestPutTopology_RejectsFilteredLinkWithSwitch(t *testing.T) {
	h, _, draftID := newTestServer(t)
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
	res := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "two routers") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestPutTopology_RejectsUnknownExport(t *testing.T) {
	h, _, draftID := newTestServer(t)
	doc := TopologyDoc{
		Devices: []DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
		Links: []LinkDoc{{
			A:      EndpointDoc{Device: "r1"},
			B:      EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"ghost"}, BExports: []string{"n2"}},
		}},
	}
	res := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), doc)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d", res.Code)
	}
	if !strings.Contains(errorBody(t, res), "unknown export entity") {
		t.Fatalf("unexpected error body: %s", errorBody(t, res))
	}
}

func TestGetLinkExports(t *testing.T) {
	h, _, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=0&side=a"), nil)
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
		if rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?"+q), nil); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: want 422, got %d", q, rec.Code)
		}
	}
	if rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=7&side=a"), nil); rec.Code != http.StatusNotFound {
		t.Fatalf("out-of-range link: want 404, got %d", rec.Code)
	}
}

func TestGetLinkExports_ChainsThroughOtherFilteredLinks(t *testing.T) {
	h, _, draftID := newTestServer(t)
	topo := TopologyDoc{
		Devices: []DeviceDoc{
			{Name: "r1", Kind: "router"},
			{Name: "r2", Kind: "router"},
			{Name: "r3", Kind: "router"},
		},
		Links: []LinkDoc{
			{
				A:      EndpointDoc{Device: "r1"},
				B:      EndpointDoc{Device: "r2"},
				Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
			},
			{
				A:      EndpointDoc{Device: "r1"},
				B:      EndpointDoc{Device: "r3"},
				Filter: &LinkFilterDoc{AExports: []string{}, BExports: []string{}},
			},
		},
		Networks: []NetworkDoc{
			{Name: "n-office", Subnets: []string{"office"}, Attach: []EndpointDoc{{Device: "r1"}}},
			{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []EndpointDoc{{Device: "r2"}}},
		},
	}
	if rec := doJSON(t, h, http.MethodPut, draftPath(draftID, "topology"), topo); rec.Code != http.StatusOK {
		t.Fatalf("save topology: status = %d, body = %s", rec.Code, rec.Body)
	}

	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=1&side=a"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// r1 re-announces n-dmz — learned only via its filtered link to r2 —
	// on its other filtered link toward r3.
	want := []EntityDoc{
		{Name: "n-dmz"}, {Name: "n-office"},
		{Name: "dmz", CIDR: "10.0.1.0/24"}, {Name: "office", CIDR: "10.0.0.0/24"},
	}
	if !slices.EqualFunc(got.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", got.Entities, want)
	}
}

func TestPostTopologyOperation_ReturnsCanonicalSnapshot(t *testing.T) {
	h, _, id := newTestServer(t)
	// The brief's literal example links r2-r1, but the fixture already
	// has an r1-r2 link and topology.Validate rejects a duplicate pair
	// regardless of side order; seed a third device so create-link has a
	// genuinely new pair to add.
	seed := doJSON(t, h, http.MethodPost, draftPath(id, "topology/operations"), map[string]any{
		"kind": "create-device", "device": map[string]string{"name": "r3", "kind": "router"},
	})
	if seed.Code != http.StatusOK {
		t.Fatalf("seed device: status=%d body=%s", seed.Code, seed.Body)
	}
	rec := doJSON(t, h, http.MethodPost, draftPath(id, "topology/operations"), map[string]any{
		"kind": "create-link", "link": map[string]any{"a": map[string]string{"device": "r3"}, "b": map[string]string{"device": "r1"}},
	})
	if rec.Code != http.StatusOK || rec.Header().Get("X-Draft-Revision") == "" {
		t.Fatalf("status=%d header=%q", rec.Code, rec.Header())
	}
	var snap struct {
		Topology TopologyDoc `json:"topology"`
		Layout   LayoutDoc   `json:"layout"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(snap.Topology.Links) != 2 {
		t.Fatalf("want 2 links (fixture's r1-r2 plus the new r3-r1) in canonical snapshot, got %+v", snap.Topology.Links)
	}
}

// TestDeletionErrorsFromDocsAcceptsRenamedRuleRefs ensures a topology
// operation that changes rules together with a network is not rejected as a
// deletion based on the draft's pre-operation rules.
func TestDeletionErrorsFromDocsAcceptsRenamedRuleRefs(t *testing.T) {
	prev := mustParseFixtureDoc(t)
	prev.Rules.Chains[0].Rules[0].Src = []string{"n-office"}
	next, err := applyTopologyOperation(prev, topologyOperation{
		Kind: "update-network", NetworkName: "n-office",
		Network: &NetworkDoc{Name: "n-hq", Subnets: []string{"office"}},
	})
	if err != nil {
		t.Fatalf("update-network: %v", err)
	}
	if errs := deletionErrorsFromDocs(prev, next); len(errs) != 0 {
		t.Fatalf("rename deletion errors = %v, want none", errs)
	}
}

func TestPostTopologyOperation_StaleRevisionReturnsConflict(t *testing.T) {
	h, _, draftID := newTestServer(t)

	getRec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	staleRevision := getRec.Header().Get("X-Draft-Revision")
	if staleRevision == "" {
		t.Fatal("expected an initial X-Draft-Revision")
	}

	// A first operation moves the draft off staleRevision.
	first := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
		"kind": "create-device", "device": map[string]string{"name": "sw1", "kind": "switch"},
	})
	if first.Code != http.StatusOK {
		t.Fatalf("seed operation: status = %d, body = %s", first.Code, first.Body)
	}

	// Retrying against the now-stale revision must conflict, independent
	// of whether the retried operation itself would otherwise apply.
	body := marshalJSON(t, map[string]any{"kind": "create-device", "device": map[string]string{"name": "sw2", "kind": "switch"}})
	req := httptest.NewRequest(http.MethodPost, draftPath(draftID, "topology/operations"), bytes.NewReader(body))
	req.Header.Set("X-Draft-Revision", staleRevision)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestPostTopologyOperation_InvalidFilteredLinkIsUnprocessable(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	seed := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
		"kind": "create-device", "device": map[string]string{"name": "r3", "kind": "router"},
	})
	if seed.Code != http.StatusOK {
		t.Fatalf("seed device: status=%d body=%s", seed.Code, seed.Body)
	}
	before := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)

	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
		"kind": "create-link",
		"link": map[string]any{
			"a":      map[string]string{"device": "r3"},
			"b":      map[string]string{"device": "r1"},
			"filter": map[string]any{"aExports": []string{"ghost"}, "bExports": []string{"n-dmz"}},
		},
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if msg := errorBody(t, rec); !strings.Contains(msg, "unknown export entity") {
		t.Fatalf("unexpected error body: %s", msg)
	}
	after := marshalJSON(t, readDraftDoc(t, projects, draftID).Topology)
	if !bytes.Equal(before, after) {
		t.Fatalf("rejected operation must not be persisted")
	}
}

func TestPostTopologyOperation_SharesRevisionWithLayout(t *testing.T) {
	h, _, draftID := newTestServer(t)

	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
		"kind": "set-device-position", "deviceName": "r1", "position": map[string]float64{"x": 5, "y": 6},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	opRevision := rec.Header().Get("X-Draft-Revision")

	var snap struct {
		Topology TopologyDoc `json:"topology"`
		Layout   LayoutDoc   `json:"layout"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if snap.Layout.Devices["r1"] != (LayoutPoint{X: 5, Y: 6}) {
		t.Fatalf("layout position not applied: %+v", snap.Layout)
	}

	// One draft revision covers both topology and layout: the plain GETs
	// for each must report the same revision the operation just produced.
	topoRec := doJSON(t, h, http.MethodGet, draftPath(draftID, "topology"), nil)
	if got := topoRec.Header().Get("X-Draft-Revision"); got != opRevision {
		t.Fatalf("topology revision %q != operation revision %q", got, opRevision)
	}
	layoutRec := doJSON(t, h, http.MethodGet, draftPath(draftID, "layout"), nil)
	if got := layoutRec.Header().Get("X-Draft-Revision"); got != opRevision {
		t.Fatalf("layout revision %q != operation revision %q", got, opRevision)
	}
}

func TestPostTopologyOperation_LinkCandidatesResolveByEndpointsAfterSortedRoundTrip(t *testing.T) {
	h, _, draftID := newTestServer(t)

	// The fixture's r1-r2 link is already at storage index 0. Add a
	// second link whose canonical key ("a0|z9") sorts before "r1|r2", so
	// pgstore's alphabetic reconstruction moves it to index 0 instead: a
	// stale array index would now resolve to the wrong link.
	for _, dev := range []string{"a0", "z9"} {
		rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
			"kind": "create-device", "device": map[string]string{"name": dev, "kind": "router"},
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("create device %s: status = %d, body = %s", dev, rec.Code, rec.Body)
		}
	}
	rec := doJSON(t, h, http.MethodPost, draftPath(draftID, "topology/operations"), map[string]any{
		"kind": "create-link", "link": map[string]any{"a": map[string]string{"device": "z9"}, "b": map[string]string{"device": "a0"}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("create link: status = %d, body = %s", rec.Code, rec.Body)
	}
	var snap struct {
		Topology TopologyDoc `json:"topology"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	first := snap.Topology.Links[0]
	if (first.A.Device != "a0" && first.B.Device != "a0") || (first.A.Device != "z9" && first.B.Device != "z9") {
		t.Fatalf("expected canonical key sort (\"a0|z9\" < \"r1|r2\") to put a0-z9 first, got %+v", snap.Topology.Links)
	}

	// The original r1-r2 link still resolves correctly by endpoint pair,
	// even though it's no longer at index 0.
	got := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?a=r1&b=r2&side=a"), nil)
	if got.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", got.Code, got.Body)
	}
	var out struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := []EntityDoc{{Name: "n-office"}, {Name: "office", CIDR: "10.0.0.0/24"}}
	if !slices.EqualFunc(out.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", out.Entities, want)
	}
}

func TestGetLinkExports_ResolvesByEndpointPair(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?a=r1&b=r2&side=a"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := []EntityDoc{{Name: "n-office"}, {Name: "office", CIDR: "10.0.0.0/24"}}
	if !slices.EqualFunc(got.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", got.Entities, want)
	}

	// Order of a/b doesn't matter: the pair is canonicalized before lookup.
	rec = doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?a=r2&b=r1&side=b"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestGetLinkExports_LegacyIndexQueryStillWorks(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?link=0&side=a"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got struct {
		Entities []EntityDoc `json:"entities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := []EntityDoc{{Name: "n-office"}, {Name: "office", CIDR: "10.0.0.0/24"}}
	if !slices.EqualFunc(got.Entities, want, func(a, b EntityDoc) bool { return a == b }) {
		t.Fatalf("entities = %+v, want %+v", got.Entities, want)
	}
}

func TestGetLinkExports_UnknownEndpointPairIs404(t *testing.T) {
	h, _, draftID := newTestServer(t)
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?a=r1&b=ghost&side=a"), nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestGetLinkExports_MissingEndpointFallsBackToLegacyAndRejectsIncomplete(t *testing.T) {
	h, _, draftID := newTestServer(t)
	// Only "a" present (no "b"): not a valid endpoint-pair query, and
	// there's no legacy "link" param either, so this is 422, not a silent
	// fallback to link index 0.
	rec := doJSON(t, h, http.MethodGet, draftPath(draftID, "link-exports?a=r1&side=a"), nil)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}

func TestDiagnoseHandler(t *testing.T) {
	h, _, draftID := newTestServer(t)
	diagnosePath := draftPath(draftID, "diagnose")

	t.Run("allowed flow reports matched rule", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
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
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "nonsense", "dst": "10.0.1.7"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "src") {
			t.Fatalf("error should mention src, got %q", msg)
		}
	})

	t.Run("unknown IP is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "10.0.0.5", "dst": "192.168.99.99"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, "не принадлежит") {
			t.Fatalf("error should explain unknown IP, got %q", msg)
		}
	})

	t.Run("bad proto is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath, map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "sctp"})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d", rec.Code)
		}
	})

	t.Run("invalid port string is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"abc"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if msg := errorBody(t, rec); !strings.Contains(msg, `"abc"`) {
			t.Fatalf("error should mention the bad port, got %q", msg)
		}
	})

	t.Run("inverted port range is unprocessable", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "srcPorts": []string{"2000:1000"}})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("valid port range passes validation", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, diagnosePath,
			map[string]any{"src": "10.0.0.5", "dst": "10.0.1.7", "proto": "tcp", "dstPorts": []string{"443", "1024:65535"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}

// writeDraftRules bypasses the PUT handler's own validation, going
// straight through pgstore — used to simulate rules content that
// somehow already made it into storage without passing normal checks.
func writeDraftRules(t *testing.T, projects *pgstore.Store, draftID string, rawYAML string) {
	t.Helper()
	ctx := context.Background()
	var policy projectdoc.PolicyDoc
	if err := yaml.Unmarshal([]byte(rawYAML), &policy); err != nil {
		t.Fatalf("parse rules yaml: %v", err)
	}
	doc, revision, err := projects.ReadDraft(ctx, draftID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	doc.Rules = policy
	if _, err := projects.WriteDraft(ctx, draftID, doc, revision); err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}
}

func TestLintEndpoint(t *testing.T) {
	h, projects, draftID := newTestServer(t)
	lintPath := draftPath(draftID, "lint")

	t.Run("clean policy has no findings", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
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
		writeDraftRules(t, projects, draftID, `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`)
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
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
		writeDraftRules(t, projects, draftID, `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: bad, src: [no-such-subnet], dst: [any], proto: any, action: allow}
`)
		rec := doJSON(t, h, http.MethodGet, lintPath, nil)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	})
}
