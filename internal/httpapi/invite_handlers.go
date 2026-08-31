package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type inviteInfoResponse struct {
	Username string `json:"username"`
}

// getInvite is public: an invited user isn't logged in yet.
func (h *handlers) getInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	user, err := h.users.GetUserByInviteToken(r.Context(), token)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, inviteInfoResponse{Username: user.Username})
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrInviteExpired):
		writeError(w, http.StatusGone, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

type acceptInviteRequest struct {
	Password        string `json:"password"`
	ConfirmPassword string `json:"confirmPassword"`
}

// acceptInvite is public, same reasoning as getInvite.
func (h *handlers) acceptInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	var req acceptInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, errors.New("password must be at least 8 characters"))
		return
	}
	if req.Password != req.ConfirmPassword {
		writeError(w, http.StatusBadRequest, errors.New("passwords do not match"))
		return
	}

	_, err := h.users.ActivateUser(r.Context(), token, req.Password)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrInviteExpired):
		writeError(w, http.StatusGone, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}
