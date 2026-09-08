package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

// NewServer builds the HTTP handler for firenet's JSON API. It is an
// adapter, at the same tier as the former CLI: it reuses internal/topology,
// internal/rules and internal/app for all domain logic and knows nothing
// about any UI. The web UI is a separate service (frontend/) that talks to
// this API.
// Every /api/ route requires a valid session (login/logout/invites
// excepted).
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
	apiMux.HandleFunc("GET /api/versions/current/search-index", h.getCurrentSearchIndex)
	apiMux.HandleFunc("POST /api/versions/current/validate", h.validateCurrent)
	apiMux.HandleFunc("POST /api/versions/current/compile", h.compileCurrent)
	apiMux.HandleFunc("POST /api/versions/current/diagnose", h.diagnoseCurrent)
	apiMux.HandleFunc("POST /api/versions/current/diagnose/spread", h.spreadCurrent)
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
	apiMux.HandleFunc("POST /api/drafts/{id}/diagnose/spread", h.spreadDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/lint", h.lintDraft)
	apiMux.HandleFunc("GET /api/drafts/{id}/search-index", h.getDraftSearchIndex)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.HandleFunc("GET /api/invites/{token}", h.getInvite)
	mux.HandleFunc("POST /api/invites/{token}", h.acceptInvite)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	return withLogging(log, withAPICache(mux))
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
