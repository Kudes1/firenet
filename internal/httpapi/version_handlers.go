package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

type versionInfoResponse struct {
	ID          int64  `json:"id"`
	CreatedAt   string `json:"createdAt"`
	ConfirmedBy string `json:"confirmedBy,omitempty"`
	DraftID     string `json:"draftId,omitempty"`
	Note        string `json:"note,omitempty"`
}

func toVersionInfoResponse(v pgstore.VersionInfo) versionInfoResponse {
	return versionInfoResponse{
		ID: v.ID, CreatedAt: v.CreatedAt.Format(time.RFC3339),
		ConfirmedBy: v.ConfirmedBy, DraftID: v.DraftID, Note: v.Note,
	}
}

func (h *handlers) versionHistory(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	history, err := h.projects.History(r.Context(), limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	resp := make([]versionInfoResponse, len(history))
	for i, v := range history {
		resp[i] = toVersionInfoResponse(v)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) versionDiff(w http.ResponseWriter, r *http.Request) {
	from, err1 := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	to, err2 := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, errors.New("from and to must be version numbers"))
		return
	}
	diffs, err := h.projects.DiffVersions(r.Context(), from, to)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toEntityDiffResponses(diffs))
}

// restoreVersion is admin-only (gated by auth.RequireAdmin at the route,
// Task 13).
func (h *handlers) restoreVersion(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.ParseInt(r.PathValue("n"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid version number"))
		return
	}
	admin, _ := auth.UserFromContext(r.Context())
	newVersion, err := h.projects.Restore(r.Context(), n, admin)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": newVersion})
}
