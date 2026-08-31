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
