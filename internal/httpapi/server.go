package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"html/template"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

// NewServer builds the HTTP handler for firenet's web UI and JSON API.
// Every /api/ route requires a valid session (login/logout excepted).
// Project content lives entirely in projects (internal/pgstore): the
// current confirmed version is read-only everywhere, edits only ever
// happen inside a personal draft.
func NewServer(projects *pgstore.Store, users *auth.Store, log *slog.Logger) http.Handler {
	h := &handlers{projects: projects, users: users, log: log}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/me", h.me)
	apiMux.Handle("GET /api/users", auth.RequireAdmin(http.HandlerFunc(h.listUsers)))
	apiMux.Handle("POST /api/users", auth.RequireAdmin(http.HandlerFunc(h.createUser)))
	apiMux.Handle("DELETE /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.deleteUser)))
	apiMux.Handle("PATCH /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.updateUser)))
	apiMux.Handle("POST /api/users/{id}/invite", auth.RequireAdmin(http.HandlerFunc(h.regenerateInvite)))

	apiMux.HandleFunc("GET /api/versions", h.versionHistory)
	apiMux.HandleFunc("GET /api/versions/diff", h.versionDiff)
	apiMux.Handle("POST /api/versions/{n}/restore", auth.RequireAdmin(http.HandlerFunc(h.restoreVersion)))
	apiMux.HandleFunc("GET /api/versions/current/topology", h.getCurrentTopology)
	apiMux.HandleFunc("GET /api/versions/current/subnets", h.getCurrentSubnets)
	apiMux.HandleFunc("GET /api/versions/current/rules", h.getCurrentRules)
	apiMux.HandleFunc("GET /api/versions/current/layout", h.getCurrentLayout)
	apiMux.HandleFunc("GET /api/versions/current/link-exports", h.getCurrentLinkExports)
	apiMux.HandleFunc("POST /api/versions/current/validate", h.validateCurrent)
	apiMux.HandleFunc("POST /api/versions/current/compile", h.compileCurrent)
	apiMux.HandleFunc("POST /api/versions/current/diagnose", h.diagnoseCurrent)
	apiMux.HandleFunc("GET /api/versions/current/lint", h.lintCurrent)

	apiMux.HandleFunc("POST /api/drafts", h.createDraft)
	apiMux.HandleFunc("GET /api/drafts", h.listDrafts)
	apiMux.HandleFunc("DELETE /api/drafts/{id}", h.deleteDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}", h.getDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/diff", h.draftDiff)
	apiMux.Handle("POST /api/drafts/{id}/confirm", auth.RequireAdmin(http.HandlerFunc(h.confirmDraft)))
	apiMux.HandleFunc("GET /api/drafts/{id}/topology", h.getDraftTopology)
	apiMux.HandleFunc("PUT /api/drafts/{id}/topology", h.putDraftTopology)
	apiMux.HandleFunc("POST /api/drafts/{id}/topology/operations", h.postDraftTopologyOperation)
	apiMux.HandleFunc("POST /api/drafts/{id}/topology/operations/batch", h.postDraftTopologyOperationsBatch)
	apiMux.HandleFunc("GET /api/drafts/{id}/subnets", h.getDraftSubnets)
	apiMux.HandleFunc("PUT /api/drafts/{id}/subnets", h.putDraftSubnets)
	apiMux.HandleFunc("GET /api/drafts/{id}/rules", h.getDraftRules)
	apiMux.HandleFunc("PUT /api/drafts/{id}/rules", h.putDraftRules)
	apiMux.HandleFunc("GET /api/drafts/{id}/layout", h.getDraftLayout)
	apiMux.HandleFunc("PUT /api/drafts/{id}/layout", h.putDraftLayout)
	apiMux.HandleFunc("GET /api/drafts/{id}/link-exports", h.getDraftLinkExports)
	apiMux.HandleFunc("POST /api/drafts/{id}/validate", h.validateDraft)
	apiMux.HandleFunc("POST /api/drafts/{id}/compile", h.compileDraft)
	apiMux.HandleFunc("POST /api/drafts/{id}/diagnose", h.diagnoseDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/lint", h.lintDraft)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.HandleFunc("GET /api/invites/{token}", h.getInvite)
	mux.HandleFunc("POST /api/invites/{token}", h.acceptInvite)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	pages := parsePageTemplates()

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /login", servePage("login.html"))
	mux.HandleFunc("GET /invite/{token}", servePage("invite.html"))
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", serveTemplatedPage(mustPageTemplate(pages, "subnets"), templatedPages["subnets"].data))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/devices", serveTemplatedPage(mustPageTemplate(pages, "devices"), templatedPages["devices"].data))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", serveTemplatedPage(mustPageTemplate(pages, "unions"), templatedPages["unions"].data))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", serveTemplatedPage(mustPageTemplate(pages, "compile"), templatedPages["compile"].data))
	mux.HandleFunc("GET /ui/diagnose", serveTemplatedPage(mustPageTemplate(pages, "diagnose"), templatedPages["diagnose"].data))
	mux.HandleFunc("GET /ui/users", serveTemplatedPage(mustPageTemplate(pages, "users"), templatedPages["users"].data))
	mux.HandleFunc("GET /ui/drafts", serveTemplatedPage(mustPageTemplate(pages, "drafts"), templatedPages["drafts"].data))
	mux.HandleFunc("GET /ui/history", serveTemplatedPage(mustPageTemplate(pages, "history"), templatedPages["history"].data))

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err) // embedded at build time; can't fail at runtime
	}
	mux.Handle("/", noCache(webRoot, http.FileServer(http.FS(webRoot))))

	return withLogging(log, mux)
}

// noCache lets browsers keep assets cached but forbids reuse without
// revalidation: the embed FS carries no modification times, so the file
// server has neither Last-Modified nor ETag, and browsers would otherwise
// heuristically serve stale JS after a rebuild. A content-hash ETag turns
// every revalidation into a cheap 304; a rebuild changes the hash and the
// fresh bytes are served.
func noCache(root fs.FS, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if b, err := fs.ReadFile(root, strings.TrimPrefix(path.Clean(r.URL.Path), "/")); err == nil {
				sum := sha256.Sum256(b)
				etag := `"` + hex.EncodeToString(sum[:8]) + `"`
				w.Header().Set("ETag", etag)
				w.Header().Set("Cache-Control", "no-cache")
				if r.Header.Get("If-None-Match") == etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// servePage renders one of the embedded static HTML pages.
func servePage(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := webFiles.ReadFile("web/" + name)
		if err != nil {
			http.Error(w, "page not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	}
}

type pageData struct {
	Title  string
	Nav    string
	Script string
}

type templatedPage struct {
	file string
	data pageData
}

// templatedPages lists every page migrated onto the shared layout: its
// content-template file and the per-page data rendered into it, keyed by
// the same name parsePageTemplates uses. One table instead of two (a file
// map plus separate pageData literals at each route registration) so a
// page's file and its Title/Nav/Script can't drift apart as more pages
// migrate.
var templatedPages = map[string]templatedPage{
	"subnets":  {file: "templates/subnets.html", data: pageData{Title: "firenet — подсети", Nav: "subnets", Script: "subnets.js"}},
	"unions":   {file: "templates/unions.html", data: pageData{Title: "firenet — объединения", Nav: "unions", Script: "unions.js"}},
	"diagnose": {file: "templates/diagnose.html", data: pageData{Title: "firenet — диагностика", Nav: "diagnose", Script: "diagnose.js"}},
	"compile":  {file: "templates/compile.html", data: pageData{Title: "firenet — компиляция", Nav: "compile", Script: "compile.js"}},
	"history":  {file: "templates/history.html", data: pageData{Title: "firenet — история версий", Nav: "history", Script: "history.js"}},
	"drafts":   {file: "templates/drafts.html", data: pageData{Title: "firenet — черновики", Nav: "drafts", Script: "drafts.js"}},
	"devices":  {file: "templates/devices.html", data: pageData{Title: "firenet — устройства", Nav: "devices", Script: "devices.js"}},
	"users":    {file: "templates/users.html", data: pageData{Title: "firenet — пользователи", Nav: "users", Script: "users.js"}},
}

// parsePageTemplates parses layout.html once and Clone()s it per page before
// parsing that page's own content file into the clone. Parsing layout.html
// and every content file into one shared *template.Template would collide:
// every file's {{define "content"}} lands in the same namespace (Go
// template blocks aren't scoped per source file), so the last one parsed
// would silently win for every page's {{template "content" .}} call.
//
// html/template's contextual-escaping errors surface at Execute, not at
// Parse: template.Must alone only catches a broken template at boot if
// something happens to execute it before the first live request does. The
// warm-up ExecuteTemplate below makes that guarantee unconditional instead
// of depending on test coverage.
func parsePageTemplates() map[string]*template.Template {
	base := template.Must(template.ParseFS(templateFiles, "templates/layout.html"))
	pages := make(map[string]*template.Template, len(templatedPages))
	for name, page := range templatedPages {
		clone := template.Must(base.Clone())
		tmpl := template.Must(clone.ParseFS(templateFiles, page.file))
		if err := tmpl.ExecuteTemplate(io.Discard, "layout", page.data); err != nil {
			panic(err)
		}
		pages[name] = tmpl
	}
	return pages
}

// mustPageTemplate looks up a page parsed by parsePageTemplates, panicking
// at server construction if name doesn't match a parsed page. Without this,
// a typo'd route registration (pages["subnet"] instead of pages["subnets"])
// would return a nil *template.Template that only nil-derefs the first time
// someone requests that route, instead of failing at boot like every other
// broken-template case parsePageTemplates already guards against.
func mustPageTemplate(pages map[string]*template.Template, name string) *template.Template {
	tmpl, ok := pages[name]
	if !ok {
		panic("httpapi: no parsed template for page " + name)
	}
	return tmpl
}

// serveTemplatedPage renders a page parsed by parsePageTemplates. It
// replaces servePage only for routes migrated onto the shared layout;
// every other page keeps using servePage unchanged.
func serveTemplatedPage(tmpl *template.Template, data pageData) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := tmpl.ExecuteTemplate(w, "layout", data); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
		}
	}
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
