package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestRequireAuth(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "alice", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	var gotUser User
	protected := RequireAuth(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, _ = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("no cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		protected.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got status %d, want 401", rec.Code)
		}
	})

	t.Run("valid cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sess.Token})
		protected.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200", rec.Code)
		}
		if gotUser.Username != "alice" {
			t.Fatalf("got user %q, want alice", gotUser.Username)
		}
	})
}

func TestRequireAdmin(t *testing.T) {
	admin := User{ID: "1", Username: "admin1", Role: RoleAdmin}
	user := User{ID: "2", Username: "user1", Role: RoleUser}
	protected := RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	for _, tc := range []struct {
		name string
		user User
		want int
	}{
		{"admin", admin, http.StatusOK},
		{"non-admin", user, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req = req.WithContext(context.WithValue(req.Context(), ctxKey{}, tc.user))
			protected.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
