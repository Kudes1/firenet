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
	Password string `json:"password"`
	Role     string `json:"role"`
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
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, errors.New("username and password are required"))
		return
	}

	user, err := h.users.CreateUser(r.Context(), req.Username, req.Password, role)
	if err != nil {
		if errors.Is(err, auth.ErrUsernameTaken) {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, toUserResponse(user))
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
