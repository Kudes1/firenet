package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

	body, _ := json.Marshal(createUserRequest{Username: "ivan", Role: "user"})
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

	body, _ := json.Marshal(createUserRequest{Username: "someone", Role: "user"})
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

func TestCreateUserReturnsInviteLink(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	body, _ := json.Marshal(createUserRequest{Username: "rosa", Role: "user"})
	req := httptest.NewRequest(http.MethodPost, "/api/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("got status %d, want 201; body: %s", rec.Code, rec.Body.String())
	}

	var resp createUserResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.User.Activated {
		t.Fatal("a freshly invited user should not be activated yet")
	}
	if !strings.Contains(resp.InviteURL, "/invite/") {
		t.Fatalf("inviteUrl = %q, want it to contain /invite/", resp.InviteURL)
	}
}

func TestGetDraft(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	ctx := context.Background()

	// Create owner user and draft
	if _, err := users.CreateUser(ctx, "owner", "password-1", auth.RoleUser); err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}

	// Create unrelated user
	if _, err := users.CreateUser(ctx, "unrelated", "password-2", auth.RoleUser); err != nil {
		t.Fatalf("CreateUser unrelated: %v", err)
	}

	ownerCookie := loginAndGetCookie(t, srv, "owner", "password-1")
	unrelatedCookie := loginAndGetCookie(t, srv, "unrelated", "password-2")
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	// Create owner handler
	ownerHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(ownerCookie)
		srv.ServeHTTP(w, r)
	})

	// Create unrelated handler
	unrelatedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(unrelatedCookie)
		srv.ServeHTTP(w, r)
	})

	// Create admin handler
	adminHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(adminCookie)
		srv.ServeHTTP(w, r)
	})

	// Create a draft as owner user (we need to call the API)
	createBody, _ := json.Marshal(createDraftRequest{Name: "work"})
	req := httptest.NewRequest(http.MethodPost, "/api/drafts", bytes.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(ownerCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create draft failed: status %d, body %s", rec.Code, rec.Body.String())
	}
	var draftResp draftResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &draftResp); err != nil {
		t.Fatalf("decode draft response: %v", err)
	}
	draftID := draftResp.ID

	// Test: owner can access the draft
	rec = httptest.NewRecorder()
	ownerHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/drafts/"+draftID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	var got draftResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != draftID || got.Name != "work" || got.Status != "open" {
		t.Fatalf("draft = %+v", got)
	}

	// Test: admin can access the draft
	rec = httptest.NewRecorder()
	adminHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/drafts/"+draftID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("admin access: status = %d, body = %s", rec.Code, rec.Body)
	}

	// Test: unrelated user gets 403
	rec = httptest.NewRecorder()
	unrelatedHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/drafts/"+draftID, nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unrelated user: status = %d, want 403, body = %s", rec.Code, rec.Body)
	}

	// Test: missing draft gets 404
	rec = httptest.NewRecorder()
	ownerHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/drafts/00000000-0000-0000-0000-000000000000", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing draft: status = %d, want 404, body = %s", rec.Code, rec.Body)
	}
}
