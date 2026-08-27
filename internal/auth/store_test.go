package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestCreateAndGetUser(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	created, err := store.CreateUser(ctx, "alice", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if created.ID == "" || created.Role != RoleUser {
		t.Fatalf("unexpected created user: %+v", created)
	}

	got, err := store.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if got.ID != created.ID {
		t.Fatalf("got id %q, want %q", got.ID, created.ID)
	}
}

func TestCreateUserDuplicateUsername(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	if _, err := store.CreateUser(ctx, "bob", "hunter22222", RoleUser); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := store.CreateUser(ctx, "bob", "another-pw12", RoleUser); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("got err %v, want ErrUsernameTaken", err)
	}
}

func TestGetUserByUsernameNotFound(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if _, err := store.GetUserByUsername(context.Background(), "nobody"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("got err %v, want ErrUserNotFound", err)
	}
}

func TestListUsers(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	if _, err := store.CreateUser(ctx, "carol", "hunter22222", RoleAdmin); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := store.CreateUser(ctx, "dave", "hunter22222", RoleUser); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	users, err := store.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("got %d users, want 2", len(users))
	}
}

func TestDeleteUserRefusesLastAdmin(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	admin, err := store.CreateUser(ctx, "onlyadmin", "hunter22222", RoleAdmin)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if err := store.DeleteUser(ctx, admin.ID); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("got err %v, want ErrLastAdmin", err)
	}
}

func TestDeleteUserAllowsNonLastAdmin(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	if _, err := store.CreateUser(ctx, "admin1", "hunter22222", RoleAdmin); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	admin2, err := store.CreateUser(ctx, "admin2", "hunter22222", RoleAdmin)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if err := store.DeleteUser(ctx, admin2.ID); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}
	if _, err := store.GetUserByUsername(ctx, "admin2"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("got err %v, want ErrUserNotFound after delete", err)
	}
}

func TestBootstrapAdminCreatesOnlyOnce(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	if err := store.BootstrapAdmin(ctx, "root", "hunter22222"); err != nil {
		t.Fatalf("BootstrapAdmin: %v", err)
	}
	if err := store.BootstrapAdmin(ctx, "someoneelse", "hunter22222"); err != nil {
		t.Fatalf("second BootstrapAdmin call should be a no-op, got: %v", err)
	}

	users, err := store.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != 1 || users[0].Username != "root" {
		t.Fatalf("got users %+v, want only the first bootstrapped admin", users)
	}
}

func TestBootstrapAdminRequiresCredentialsWhenEmpty(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if err := store.BootstrapAdmin(context.Background(), "", ""); err == nil {
		t.Fatal("expected an error when no users exist and no admin credentials are given")
	}
}

func TestAuthenticate(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	if _, err := store.CreateUser(ctx, "erin", "correct-password", RoleUser); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if _, err := store.Authenticate(ctx, "erin", "correct-password"); err != nil {
		t.Fatalf("Authenticate with correct password: %v", err)
	}
	if _, err := store.Authenticate(ctx, "erin", "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("got err %v, want ErrInvalidCredentials", err)
	}
	if _, err := store.Authenticate(ctx, "nobody", "whatever12"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("got err %v, want ErrInvalidCredentials for unknown user", err)
	}
}
