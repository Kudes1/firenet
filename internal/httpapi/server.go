package httpapi

import (
	"io/fs"
	"log/slog"
	"net/http"
)

// NewServer builds the HTTP handler for firenet's web UI and JSON API,
// backed by store. Routing/middleware here is deliberately decoupled from
// "how many projects" or auth — a future team server can wrap this with its
// own routing and auth layer and pick a ProjectStore per request instead of
// once at startup, without touching a single handler.
func NewServer(store ProjectStore, log *slog.Logger) http.Handler {
	h := &handlers{store: store, log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/topology", h.getTopology)
	mux.HandleFunc("PUT /api/topology", h.putTopology)
	mux.HandleFunc("GET /api/subnets", h.getSubnets)
	mux.HandleFunc("PUT /api/subnets", h.putSubnets)
	mux.HandleFunc("GET /api/rules", h.getRules)
	mux.HandleFunc("PUT /api/rules", h.putRules)
	mux.HandleFunc("POST /api/validate", h.validate)
	mux.HandleFunc("POST /api/compile", h.compile)
	mux.HandleFunc("GET /api/layout", h.getLayout)
	mux.HandleFunc("PUT /api/layout", h.putLayout)

	mux.HandleFunc("POST /ui/compile", h.uiCompile)

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", servePage("subnets.html"))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", servePage("unions.html"))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", servePage("compile.html"))

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err) // embedded at build time; can't fail at runtime
	}
	mux.Handle("/", noCache(http.FileServer(http.FS(webRoot))))

	return withLogging(log, mux)
}

// noCache forces revalidation of embedded assets: the embed FS carries no
// modification times, so the file server has neither Last-Modified nor
// ETag to revalidate with, and browsers would otherwise heuristically
// serve stale JS after a rebuild.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
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
