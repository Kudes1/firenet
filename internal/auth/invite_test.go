package auth

import (
	"context"
	"testing"
	"time"

	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestCreateUserInvite(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	user, token, err := store.CreateUserInvite(ctx, "jill", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}
	if user.Activated {
		t.Fatal("invited user should start unactivated")
	}
	if token == "" {
		t.Fatal("CreateUserInvite returned an empty token")
	}

	got, err := store.GetUserByUsername(ctx, "jill")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if got.PasswordHash != "" {
		t.Fatalf("got password_hash %q, want empty until activation", got.PasswordHash)
	}
	if _, err := store.Authenticate(ctx, "jill", ""); err == nil {
		t.Fatal("Authenticate should reject a pending account even with an empty password")
	}
}

func TestCreateUserInviteDuplicateUsername(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	if _, _, err := store.CreateUserInvite(ctx, "kim", RoleUser); err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}
	if _, _, err := store.CreateUserInvite(ctx, "kim", RoleUser); err != ErrUsernameTaken {
		t.Fatalf("got err %v, want ErrUsernameTaken", err)
	}
}

func TestInviteTTLIsTwentyFourHours(t *testing.T) {
	if InviteTTL != 24*time.Hour {
		t.Fatalf("InviteTTL = %v, want 24h", InviteTTL)
	}
}

func TestGetUserByInviteToken(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	user, token, err := store.CreateUserInvite(ctx, "liam", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	got, err := store.GetUserByInviteToken(ctx, token)
	if err != nil {
		t.Fatalf("GetUserByInviteToken: %v", err)
	}
	if got.ID != user.ID {
		t.Fatalf("got id %q, want %q", got.ID, user.ID)
	}
}

func TestGetUserByInviteTokenUnknown(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if _, err := store.GetUserByInviteToken(context.Background(), "does-not-exist"); err != ErrUserNotFound {
		t.Fatalf("got err %v, want ErrUserNotFound", err)
	}
}

func TestGetUserByInviteTokenExpired(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	_, token, err := store.CreateUserInvite(ctx, "mia", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}
	if _, err := store.db.Exec(ctx, `UPDATE users SET invite_expires_at = $1 WHERE invite_token = $2`,
		time.Now().Add(-time.Hour), token); err != nil {
		t.Fatalf("force-expire invite: %v", err)
	}

	if _, err := store.GetUserByInviteToken(ctx, token); err != ErrInviteExpired {
		t.Fatalf("got err %v, want ErrInviteExpired", err)
	}
}

func TestActivateUser(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	_, token, err := store.CreateUserInvite(ctx, "noah", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	activated, err := store.ActivateUser(ctx, token, "brand-new-pw1")
	if err != nil {
		t.Fatalf("ActivateUser: %v", err)
	}
	if !activated.Activated {
		t.Fatal("ActivateUser should flip activated to true")
	}

	if _, err := store.Authenticate(ctx, "noah", "brand-new-pw1"); err != nil {
		t.Fatalf("Authenticate with the new password: %v", err)
	}
	if _, err := store.GetUserByInviteToken(ctx, token); err != ErrUserNotFound {
		t.Fatalf("got err %v, want ErrUserNotFound — token should be cleared after activation", err)
	}
}

func TestActivateUserExpiredToken(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	_, token, err := store.CreateUserInvite(ctx, "olivia", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}
	if _, err := store.db.Exec(ctx, `UPDATE users SET invite_expires_at = $1 WHERE invite_token = $2`,
		time.Now().Add(-time.Hour), token); err != nil {
		t.Fatalf("force-expire invite: %v", err)
	}

	if _, err := store.ActivateUser(ctx, token, "brand-new-pw1"); err != ErrInviteExpired {
		t.Fatalf("got err %v, want ErrInviteExpired", err)
	}
}
