package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"github.com/kudes1/firenet/internal/auth"
)

// NewServer builds the HTTP handler for firenet's web UI and JSON API,
// backed by store. Every /api/ route requires a valid session (login and
// logout excepted); routing/project selection otherwise stays decoupled
// from "how many projects" — a future team server can still pick a
// ProjectStore per request instead of once at startup, without touching a
// single handler.
func NewServer(store ProjectStore, users *auth.Store, log *slog.Logger) http.Handler {
	h := &handlers{store: store, users: users, log: log}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/topology", h.getTopology)
	apiMux.HandleFunc("PUT /api/topology", h.putTopology)
	apiMux.HandleFunc("GET /api/subnets", h.getSubnets)
	apiMux.HandleFunc("GET /api/link-exports", h.getLinkExports)
	apiMux.HandleFunc("PUT /api/subnets", h.putSubnets)
	apiMux.HandleFunc("GET /api/rules", h.getRules)
	apiMux.HandleFunc("PUT /api/rules", h.putRules)
	apiMux.HandleFunc("POST /api/validate", h.validate)
	apiMux.HandleFunc("POST /api/compile", h.compile)
	apiMux.HandleFunc("POST /api/diagnose", h.diagnose)
	apiMux.HandleFunc("GET /api/lint", h.lint)
	apiMux.HandleFunc("GET /api/layout", h.getLayout)
	apiMux.HandleFunc("PUT /api/layout", h.putLayout)
	apiMux.HandleFunc("GET /api/me", h.me)
	apiMux.Handle("GET /api/users", auth.RequireAdmin(http.HandlerFunc(h.listUsers)))
	apiMux.Handle("POST /api/users", auth.RequireAdmin(http.HandlerFunc(h.createUser)))
	apiMux.Handle("DELETE /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.deleteUser)))

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	mux.HandleFunc("POST /ui/compile", h.uiCompile)

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /login", servePage("login.html"))
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", servePage("subnets.html"))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", servePage("unions.html"))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", servePage("compile.html"))
	mux.HandleFunc("GET /ui/diagnose", servePage("diagnose.html"))
	mux.HandleFunc("GET /ui/users", servePage("users.html"))

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

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
