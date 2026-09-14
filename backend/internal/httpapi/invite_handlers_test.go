package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kudes1/firenet/internal/auth"
)

func TestGetInvite(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	_, token, err := users.CreateUserInvite(context.Background(), "vera", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/invites/"+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var resp inviteInfoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Username != "vera" {
		t.Fatalf("got username %q, want vera", resp.Username)
	}
}

func TestGetInviteUnknownToken(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/invites/does-not-exist", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want 404", rec.Code)
	}
}

func TestAcceptInvite(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	_, token, err := users.CreateUserInvite(context.Background(), "walt", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	body, _ := json.Marshal(acceptInviteRequest{Password: "brand-new-pw1", ConfirmPassword: "brand-new-pw1"})
	req := httptest.NewRequest(http.MethodPost, "/api/invites/"+token, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("got status %d, want 204; body: %s", rec.Code, rec.Body.String())
	}

	if _, err := users.Authenticate(context.Background(), "walt", "brand-new-pw1"); err != nil {
		t.Fatalf("Authenticate with the new password: %v", err)
	}
}

func TestAcceptInvitePasswordMismatch(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	_, token, err := users.CreateUserInvite(context.Background(), "xena", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	body, _ := json.Marshal(acceptInviteRequest{Password: "brand-new-pw1", ConfirmPassword: "different-pw1"})
	req := httptest.NewRequest(http.MethodPost, "/api/invites/"+token, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
}

func TestAcceptInviteTooShortPassword(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	_, token, err := users.CreateUserInvite(context.Background(), "yara", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	body, _ := json.Marshal(acceptInviteRequest{Password: "short", ConfirmPassword: "short"})
	req := httptest.NewRequest(http.MethodPost, "/api/invites/"+token, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
}

func TestInvitePageIsPubliclyServed(t *testing.T) {
	srv, _ := newUnauthenticatedTestServer(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/invite/some-token", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", rec.Code)
	}
}
