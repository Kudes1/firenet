package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestCreateAndGetSession(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "frank", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	sess, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sess.Token == "" {
		t.Fatal("CreateSession returned an empty token")
	}
	if sess.ExpiresAt.Before(time.Now()) {
		t.Fatal("CreateSession returned an already-expired session")
	}

	got, err := store.GetSession(ctx, sess.Token)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.ID != user.ID {
		t.Fatalf("got user %q, want %q", got.ID, user.ID)
	}
}

func TestGetSessionIncludesActivated(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "ivan-session", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	got, err := store.GetSession(ctx, sess.Token)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !got.Activated {
		t.Fatal("GetSession should report activated = true for a normally-created user")
	}
}

func TestGetSessionUnknownToken(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if _, err := store.GetSession(context.Background(), "does-not-exist"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("got err %v, want ErrSessionNotFound", err)
	}
}

func TestDeleteSession(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "grace", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := store.CreateSession(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := store.DeleteSession(ctx, sess.Token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := store.GetSession(ctx, sess.Token); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("got err %v, want ErrSessionNotFound after delete", err)
	}
}

func TestGetSessionExpired(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "heidi", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	// Insert an already-expired session directly, bypassing CreateSession's TTL.
	_, err = store.db.Exec(ctx, `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
		"expired-token", user.ID, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("insert expired session: %v", err)
	}

	if _, err := store.GetSession(ctx, "expired-token"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("got err %v, want ErrSessionNotFound for expired session", err)
	}
}
