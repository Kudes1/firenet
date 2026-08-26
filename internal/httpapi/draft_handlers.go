package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

type createDraftRequest struct {
	Name string `json:"name"`
}

type draftResponse struct {
	ID            string `json:"id"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	BaseVersionID int64  `json:"baseVersion"`
	Status        string `json:"status"`
}

func toDraftResponse(d pgstore.Draft) draftResponse {
	return draftResponse{ID: d.ID, Owner: d.Owner, Name: d.Name, BaseVersionID: d.BaseVersionID, Status: d.Status}
}

func (h *handlers) createDraft(w http.ResponseWriter, r *http.Request) {
	var req createDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, errors.New("name is required"))
		return
	}
	user, _ := auth.UserFromContext(r.Context())
	d, err := h.projects.CreateDraft(r.Context(), user, req.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toDraftResponse(d))
}

// listDrafts returns the caller's own drafts by default; admins may pass
// ?all=1 to review everyone's, per the spec's "виден ... всем admin для
// ревью".
func (h *handlers) listDrafts(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	var owner *auth.User
	if r.URL.Query().Get("all") != "1" || user.Role != auth.RoleAdmin {
		owner = &user
	}
	drafts, err := h.projects.ListDrafts(r.Context(), owner)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	resp := make([]draftResponse, len(drafts))
	for i, d := range drafts {
		resp[i] = toDraftResponse(d)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) deleteDraft(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	if err := h.projects.DeleteDraft(r.Context(), r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type entityDiffResponse struct {
	Kind   string          `json:"kind"`
	Key    string          `json:"key"`
	Change string          `json:"change"`
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
}

func toEntityDiffResponses(diffs []pgstore.EntityDiff) []entityDiffResponse {
	out := make([]entityDiffResponse, len(diffs))
	for i, d := range diffs {
		out[i] = entityDiffResponse{Kind: d.Kind, Key: d.Key, Change: d.Change, Before: d.Before, After: d.After}
	}
	return out
}

type draftDiffEntry struct {
	entityDiffResponse
	Conflict bool `json:"conflict"`
}

// draftDiff shows every entity the draft changed relative to its base
// version, each flagged with whether it also conflicts with the current
// version (someone else confirmed a change to the same entity).
func (h *handlers) draftDiff(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolveDraftForAccess(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	diffs, err := h.projects.DiffDraft(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	conflicts, err := h.projects.Conflicts(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	conflictKeys := make(map[string]bool, len(conflicts))
	for _, c := range conflicts {
		conflictKeys[c.Kind+"|"+c.Key] = true
	}

	out := make([]draftDiffEntry, len(diffs))
	for i, d := range diffs {
		out[i] = draftDiffEntry{
			entityDiffResponse: entityDiffResponse{Kind: d.Kind, Key: d.Key, Change: d.Change, Before: d.Before, After: d.After},
			Conflict:           conflictKeys[d.Kind+"|"+d.Key],
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type conflictResponse struct {
	Kind         string          `json:"kind"`
	Key          string          `json:"key"`
	DraftValue   json.RawMessage `json:"draftValue,omitempty"`
	CurrentValue json.RawMessage `json:"currentValue,omitempty"`
}

// confirmDraft is admin-only (gated by auth.RequireAdmin at the route,
// Task 13). A clean merge answers 200 with the new version number; a
// conflict answers 409 with the conflicting entities instead of erroring
// — the draft's author resolves them and re-submits.
func (h *handlers) confirmDraft(w http.ResponseWriter, r *http.Request) {
	admin, _ := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	version, conflicts, err := h.projects.Confirm(r.Context(), id, admin)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if len(conflicts) > 0 {
		resp := make([]conflictResponse, len(conflicts))
		for i, c := range conflicts {
			resp[i] = conflictResponse{Kind: c.Kind, Key: c.Key, DraftValue: c.DraftValue, CurrentValue: c.CurrentValue}
		}
		writeJSON(w, http.StatusConflict, map[string]any{"conflicts": resp})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": version})
}
