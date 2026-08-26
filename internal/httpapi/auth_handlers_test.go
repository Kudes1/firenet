package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
)

func newUnauthenticatedTestServer(t *testing.T) (http.Handler, *auth.Store) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	ctx := context.Background()
	if err := users.BootstrapAdmin(ctx, "admin", "test-password-1"); err != nil {
		t.Fatalf("bootstrap admin: %v", err)
	}
	admin, err := users.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("get admin: %v", err)
	}

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, admin); err != nil {
		t.Fatalf("seed initial version: %v", err)
	}

	return NewServer(projects, users, discardLogger()), users
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
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/versions/current/topology", nil))
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

	req2 := httptest.NewRequest(http.MethodGet, "/api/versions/current/topology", nil)
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

func loginAndGetCookie(t *testing.T, srv http.Handler, username, password string) *http.Cookie {
	t.Helper()
	body, _ := json.Marshal(loginRequest{Username: username, Password: password})
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login as %s failed: status %d, body %s", username, rec.Code, rec.Body.String())
	}
	return rec.Result().Cookies()[0]
}

func TestCreateAndListUsersAsAdmin(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	body, _ := json.Marshal(createUserRequest{Username: "ivan", Password: "hunter22222", Role: "user"})
	req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("got status %d, want 201; body: %s", rec.Code, rec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	listReq.AddCookie(adminCookie)
	listRec := httptest.NewRecorder()
	srv.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", listRec.Code)
	}
	var users []userResponse
	if err := json.Unmarshal(listRec.Body.Bytes(), &users); err != nil {
		t.Fatalf("decode users: %v", err)
	}
	if len(users) != 2 { // admin + ivan
		t.Fatalf("got %d users, want 2", len(users))
	}
}

func TestCreateUserAsNonAdminIsForbidden(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	if _, err := users.CreateUser(context.Background(), "plain", "hunter22222", auth.RoleUser); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	userCookie := loginAndGetCookie(t, srv, "plain", "hunter22222")

	body, _ := json.Marshal(createUserRequest{Username: "someone", Password: "hunter22222", Role: "user"})
	req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(userCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got status %d, want 403", rec.Code)
	}
}

func TestDeleteUser(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	target, err := users.CreateUser(context.Background(), "todelete", "hunter22222", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	req := httptest.NewRequest(http.MethodDelete, "/api/users/"+target.ID, nil)
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got status %d, want 204; body: %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteLastAdminIsRejected(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")
	adminID := mustBootstrapAdminID(t, users)

	req := httptest.NewRequest(http.MethodDelete, "/api/users/"+adminID, nil)
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
}
