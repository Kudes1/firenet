package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
)

func newUnauthenticatedTestServer(t *testing.T) (http.Handler, *auth.Store) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	if err := users.BootstrapAdmin(context.Background(), "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}

	dir := t.TempDir()
	store := FileProjectStore{
		TopologyPath: filepath.Join(dir, "topology.yaml"),
		SubnetsPath:  filepath.Join(dir, "subnets.yaml"),
		RulesPath:    filepath.Join(dir, "rules.yaml"),
		LayoutPath:   filepath.Join(dir, ".firenet-layout.json"),
	}
	if err := store.EnsureSeeded(); err != nil {
		t.Fatalf("seed store: %v", err)
	}
	return NewServer(store, users, discardLogger()), users
}

func TestLoginSetsSessionCookie(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)

	body, _ := json.Marshal(loginRequest{Username: "admin", Password: "test-password-1"})
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	if len(rec.Result().Cookies()) == 0 {
		t.Fatal("expected a session cookie to be set")
	}
}

func TestLoginWrongPassword(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)

	body, _ := json.Marshal(loginRequest{Username: "admin", Password: "wrong"})
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401", rec.Code)
	}
}

func TestProtectedRouteWithoutSessionIs401(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/topology", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401", rec.Code)
	}
}

func TestLogoutClearsSession(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	sess, err := users.CreateSession(context.Background(), mustBootstrapAdminID(t, users))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: sess.Token})
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got status %d, want 204", rec.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/topology", nil)
	req2.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: sess.Token})
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401 after logout", rec2.Code)
	}
}

func mustBootstrapAdminID(t *testing.T, users *auth.Store) string {
	t.Helper()
	u, err := users.GetUserByUsername(context.Background(), "admin")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	return u.ID
}
