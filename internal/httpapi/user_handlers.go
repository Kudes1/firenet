package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type createUserRequest struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type updateUserRequest struct {
	Role string `json:"role"`
}

type createUserResponse struct {
	User      userResponse `json:"user"`
	InviteURL string       `json:"inviteUrl"`
}

func (h *handlers) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.users.ListUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	resp := make([]userResponse, len(users))
	for i, u := range users {
		resp[i] = toUserResponse(u)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) createUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	role := auth.Role(req.Role)
	if role != auth.RoleAdmin && role != auth.RoleUser {
		writeError(w, http.StatusBadRequest, fmt.Errorf("role must be %q or %q", auth.RoleAdmin, auth.RoleUser))
		return
	}
	if req.Username == "" {
		writeError(w, http.StatusBadRequest, errors.New("username is required"))
		return
	}

	user, token, err := h.users.CreateUserInvite(r.Context(), req.Username, role)
	if err != nil {
		if errors.Is(err, auth.ErrUsernameTaken) {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, createUserResponse{User: toUserResponse(user), InviteURL: inviteURL(r, token)})
}

// inviteURL builds the public link an admin copies for an invited user.
// No reverse-proxy header handling (X-Forwarded-Proto etc.) — nothing
// else in this codebase does that either.
func inviteURL(r *http.Request, token string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/invite/" + token
}

func (h *handlers) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := h.users.DeleteUser(r.Context(), id)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, auth.ErrLastAdmin):
		writeError(w, http.StatusBadRequest, err)
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

func (h *handlers) updateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if currentUser, ok := auth.UserFromContext(r.Context()); ok && id == currentUser.ID {
		writeError(w, http.StatusBadRequest, errors.New("cannot change your own role"))
		return
	}

	var req updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	role := auth.Role(req.Role)
	if role != auth.RoleAdmin && role != auth.RoleUser {
		writeError(w, http.StatusBadRequest, fmt.Errorf("role must be %q or %q", auth.RoleAdmin, auth.RoleUser))
		return
	}

	user, err := h.users.UpdateUserRole(r.Context(), id, role)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, toUserResponse(user))
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrLastAdmin):
		writeError(w, http.StatusBadRequest, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}
