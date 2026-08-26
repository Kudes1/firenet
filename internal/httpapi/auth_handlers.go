package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userResponse struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func toUserResponse(u auth.User) userResponse {
	return userResponse{ID: u.ID, Username: u.Username, Role: string(u.Role)}
}

func (h *handlers) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	user, err := h.users.Authenticate(r.Context(), req.Username, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid username or password"))
		return
	}

	sess, err := h.users.CreateSession(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	auth.SetSessionCookie(w, sess.Token, sess.ExpiresAt)
	writeJSON(w, http.StatusOK, toUserResponse(user))
}

func (h *handlers) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.SessionCookieName); err == nil {
		_ = h.users.DeleteSession(r.Context(), cookie.Value)
	}
	auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) me(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	writeJSON(w, http.StatusOK, toUserResponse(user))
}
