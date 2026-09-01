package httpapi

import (
	"bytes"
	"html/template"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Static assets are embedded without modification times, so the file
// server sends neither Last-Modified nor ETag. Responses must therefore
// carry a content-hash ETag with Cache-Control forbidding reuse without
// revalidation: the browser keeps its cached copy, a matching
// If-None-Match gets a cheap 304, and a rebuild changes the hash.
func TestStaticAssetsNoCache(t *testing.T) {
	srv, _, _ := newTestServer(t)
	for _, path := range []string{"/common.js", "/rules.js", "/style.css", "/favicon.svg"} {
		rec := doJSON(t, srv, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("GET %s: Cache-Control = %q, want \"no-cache\"", path, cc)
		}
		etag := rec.Header().Get("ETag")
		if etag == "" {
			t.Fatalf("GET %s: no ETag", path)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("If-None-Match", etag)
		rec = httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotModified {
			t.Errorf("GET %s with If-None-Match: status %d, want 304", path, rec.Code)
		}
	}
}

func TestParsePageTemplatesRenderDistinctContent(t *testing.T) {
	pages := parsePageTemplates()
	if _, ok := pages["subnets"]; !ok {
		t.Fatal(`parsePageTemplates()["subnets"] missing`)
	}
	if _, ok := pages["unions"]; !ok {
		t.Fatal(`parsePageTemplates()["unions"] missing`)
	}

	var subnetsOut, unionsOut bytes.Buffer
	if err := pages["subnets"].ExecuteTemplate(&subnetsOut, "layout", pageData{
		Title: "firenet — подсети", Nav: "subnets", Script: "subnets.js",
	}); err != nil {
		t.Fatalf("execute subnets template: %v", err)
	}
	if err := pages["unions"].ExecuteTemplate(&unionsOut, "layout", pageData{
		Title: "firenet — объединения", Nav: "unions", Script: "unions.js",
	}); err != nil {
		t.Fatalf("execute unions template: %v", err)
	}

	subnets, unions := subnetsOut.String(), unionsOut.String()

	// Regression guard for the shared-namespace pitfall: if layout.html and
	// both content files were parsed into one shared *template.Template,
	// the last-parsed "content" block would silently win for every page.
	if !strings.Contains(subnets, `x-data="subnetsPage"`) {
		t.Error("subnets render missing x-data=\"subnetsPage\"")
	}
	if strings.Contains(subnets, `x-data="unionsPage"`) {
		t.Error("subnets render leaked unions content block")
	}
	if !strings.Contains(unions, `x-data="unionsPage"`) {
		t.Error("unions render missing x-data=\"unionsPage\"")
	}
	if strings.Contains(unions, `x-data="subnetsPage"`) {
		t.Error("unions render leaked subnets content block")
	}

	if !strings.Contains(subnets, "<title>firenet — подсети</title>") {
		t.Error("subnets render missing expected <title>")
	}
	if !strings.Contains(subnets, `data-nav="subnets"`) {
		t.Error("subnets render missing data-nav=\"subnets\"")
	}
	if !strings.Contains(unions, "<title>firenet — объединения</title>") {
		t.Error("unions render missing expected <title>")
	}
	if !strings.Contains(unions, `data-nav="unions"`) {
		t.Error("unions render missing data-nav=\"unions\"")
	}
}

func TestTemplatedPages(t *testing.T) {
	srv, _, _ := newTestServer(t)

	cases := []struct {
		path   string
		title  string
		nav    string
		marker string
	}{
		{"/ui/subnets", "firenet — подсети", "subnets", `x-data="subnetsPage"`},
		{"/ui/unions", "firenet — объединения", "unions", `x-data="unionsPage"`},
		{"/ui/diagnose", "firenet — диагностика", "diagnose", `id="diag-canvas"`},
		{"/ui/compile", "firenet — компиляция", "compile", `id="compile-run"`},
		{"/ui/history", "firenet — история версий", "history", `id="history-table"`},
		{"/ui/drafts", "firenet — черновики", "drafts", `id="drafts-table"`},
		{"/ui/devices", "firenet — устройства", "devices", `x-data="devicesPage"`},
		{"/ui/users", "firenet — пользователи", "users", `x-data="usersPage"`},
		{"/ui/networks", "firenet — сети", "networks", `x-data="networksPage"`},
		{"/ui/links", "firenet — связи", "links", `x-data="linksPage"`},
	}

	for _, c := range cases {
		rec := doJSON(t, srv, http.MethodGet, c.path, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", c.path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Errorf("GET %s: Content-Type = %q, want \"text/html; charset=utf-8\"", c.path, ct)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "<title>"+c.title+"</title>") {
			t.Errorf("GET %s: body missing <title>%s</title>", c.path, c.title)
		}
		if !strings.Contains(body, `data-nav="`+c.nav+`"`) {
			t.Errorf("GET %s: body missing data-nav=%q", c.path, c.nav)
		}
		if !strings.Contains(body, c.marker) {
			t.Errorf("GET %s: body missing %s", c.path, c.marker)
		}
		assertLayoutInvariants(t, c.path, body)
	}
}

// assertLayoutInvariants checks markers from the shared layout shell itself
// (as opposed to a page's own varying title/nav/content) — the part
// TestTemplatedPages' per-page checks don't otherwise cover, so a marker
// accidentally dropped from templates/layout.html still fails a test
// instead of silently breaking every templated page at once.
func assertLayoutInvariants(t *testing.T, path, body string) {
	t.Helper()
	for _, marker := range []string{
		"<!doctype html>",
		`name="viewport" content="width=device-width, initial-scale=1"`,
		`href="/favicon.svg"`,
		`href="/style.css"`,
		`src="/common.js"`,
		`src="/alpine.min.js"`,
		`x-data="appData()"`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("GET %s: body missing shared layout marker %q", path, marker)
		}
	}
}

func TestMustPageTemplatePanicsOnUnknownPage(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("mustPageTemplate: expected panic for unknown page name, got none")
		}
	}()
	mustPageTemplate(map[string]*template.Template{}, "does-not-exist")
}
