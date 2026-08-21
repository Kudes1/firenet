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
	mux.HandleFunc("GET /api/rules", h.getRules)
	mux.HandleFunc("PUT /api/rules", h.putRules)
	mux.HandleFunc("POST /api/validate", h.validate)
	mux.HandleFunc("POST /api/compile", h.compile)
	mux.HandleFunc("GET /api/layout", h.getLayout)
	mux.HandleFunc("PUT /api/layout", h.putLayout)

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err) // embedded at build time; can't fail at runtime
	}
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	return withLogging(log, mux)
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
