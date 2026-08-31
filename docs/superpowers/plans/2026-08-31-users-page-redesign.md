# Users Page Redesign & Invite-Link Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace admin-set passwords with a 24h invite-link activation flow, add user role editing, and restyle the users page to match the app's existing Alpine/`dialog.modal` design system.

**Architecture:** A new `activated`/`invite_token`/`invite_expires_at` set of columns on `users` (no separate table) backs invite creation, regeneration, lookup and activation in `internal/auth`. New/changed HTTP handlers expose this over `/api/users`, `/api/users/{id}/invite` (admin-only) and the public `/api/invites/{token}` pair. The frontend gets a full rewrite of `users.html`/`users.js` in the `devices.js` Alpine pattern, plus a new standalone `invite.html`/`invite.js` page (modeled on `login.html`/`login.js`) where an invited user sets their password.

**Tech Stack:** Go (`net/http` stdlib mux, `pgx/v5`, `bcrypt`), Postgres, vanilla JS with Alpine.js for the in-app page, `node:test` for JS tests.

**Spec:** `docs/superpowers/specs/2026-08-31-users-page-redesign-design.md`

## Global Constraints

- No email delivery — the admin copies the invite link and shares it manually.
- No editing of a user's username — only role is editable via the new Edit action.
- Empty `password_hash` (used for pending accounts) must never match any password via `VerifyPassword`/`bcrypt.CompareHashAndPassword` — this is relied on so `login` needs no explicit `activated` check.
- One invite per user: creating or regenerating an invite overwrites `invite_token`/`invite_expires_at` in place; no invite history table.
- Automated tests only — no manual browser verification pass (per project `CLAUDE.md`).
- Go tests run with `go test ./...`; JS tests run with `node --test 'internal/httpapi/web/*.test.js'`.

---

## Task 1: `activated` column + carry it through existing user queries

**Files:**
- Create: `internal/db/migrations/0003_user_invites.sql`
- Modify: `internal/auth/user.go`
- Modify: `internal/auth/store.go:29-88` (`CreateUser`, `GetUserByUsername`, `ListUsers`)
- Test: `internal/auth/store_test.go`

**Interfaces:**
- Produces: `auth.User.Activated bool` — every later task that builds/returns a `User` must populate it via the `activated` column.

- [ ] **Step 1: Write the migration**

```sql
-- internal/db/migrations/0003_user_invites.sql
ALTER TABLE users
  ADD COLUMN activated         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN invite_token      TEXT,
  ADD COLUMN invite_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_invite_token_idx ON users (invite_token)
  WHERE invite_token IS NOT NULL;
```

- [ ] **Step 2: Add the failing test**

```go
// internal/auth/store_test.go — append
func TestCreateUserDefaultsToActivated(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()

	created, err := store.CreateUser(ctx, "ivy", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if !created.Activated {
		t.Fatal("CreateUser should default new users to activated")
	}

	got, err := store.GetUserByUsername(ctx, "ivy")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if !got.Activated {
		t.Fatal("GetUserByUsername should report activated = true")
	}

	users, err := store.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if len(users) != 1 || !users[0].Activated {
		t.Fatalf("ListUsers = %+v, want one activated user", users)
	}
}
```

- [ ] **Step 3: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestCreateUserDefaultsToActivated -v`
Expected: FAIL — `created.Activated` is compile-error/zero-value false (the `User` struct has no `Activated` field yet).

- [ ] **Step 4: Add the field and thread it through the three queries**

```go
// internal/auth/user.go — User struct
type User struct {
	ID           string
	Username     string
	PasswordHash string
	Role         Role
	CreatedAt    time.Time
	Activated    bool
}
```

```go
// internal/auth/store.go — CreateUser
	err = s.db.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role)
		VALUES ($1, $2, $3)
		RETURNING id, username, password_hash, role, created_at, activated`,
		username, hash, string(role),
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
```

```go
// internal/auth/store.go — GetUserByUsername
	err := s.db.QueryRow(ctx, `
		SELECT id, username, password_hash, role, created_at, activated FROM users WHERE username = $1`,
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
```

```go
// internal/auth/store.go — ListUsers
	rows, err := s.db.Query(ctx, `SELECT id, username, password_hash, role, created_at, activated FROM users ORDER BY username`)
	...
	for rows.Next() {
		var u User
		var roleStr string
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated); err != nil {
```

- [ ] **Step 5: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS, all existing `internal/auth` tests still pass too.

- [ ] **Step 6: Commit**

```bash
git add internal/db/migrations/0003_user_invites.sql internal/auth/user.go internal/auth/store.go internal/auth/store_test.go
git commit -m "feat(auth): add activated/invite columns to users"
```

---

## Task 2: `CreateUserInvite`

**Files:**
- Create: `internal/auth/invite.go`
- Test: `internal/auth/invite_test.go`

**Interfaces:**
- Consumes: `newSessionToken() (string, error)` (`internal/auth/session.go:65`), `isUniqueViolation` (`internal/auth/store.go:159`), `ErrUsernameTaken` (`internal/auth/store.go:15`).
- Produces: `InviteTTL` constant, `ErrAlreadyActivated`, `ErrInviteExpired` sentinel errors, `Store.CreateUserInvite(ctx, username string, role Role) (User, string, error)` — later tasks (handlers) call this and consume the returned plaintext token.

- [ ] **Step 1: Write the failing test**

```go
// internal/auth/invite_test.go
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestCreateUserInvite -v`
Expected: FAIL — `store.CreateUserInvite` undefined.

- [ ] **Step 3: Implement**

```go
// internal/auth/invite.go
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// InviteTTL is how long a freshly generated (or regenerated) invite link
// stays valid before the admin has to regenerate it.
const InviteTTL = 24 * time.Hour

var (
	ErrAlreadyActivated = errors.New("user is already activated")
	ErrInviteExpired    = errors.New("invite link has expired")
)

// CreateUserInvite creates an unactivated user and returns a one-time
// plaintext invite token (never stored anywhere but the return value —
// the token itself lives in invite_token, unhashed, matching how
// sessions.token is already stored). The account cannot log in until
// ActivateUser sets a real password: password_hash starts as "", and
// bcrypt never matches an empty hash, so Authenticate rejects it for
// free without any explicit activated check.
func (s *Store) CreateUserInvite(ctx context.Context, username string, role Role) (User, string, error) {
	token, err := newSessionToken()
	if err != nil {
		return User{}, "", err
	}
	expiresAt := time.Now().Add(InviteTTL)

	var u User
	var roleStr string
	err = s.db.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role, activated, invite_token, invite_expires_at)
		VALUES ($1, '', $2, FALSE, $3, $4)
		RETURNING id, username, password_hash, role, created_at, activated`,
		username, string(role), token, expiresAt,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, "", ErrUsernameTaken
		}
		return User{}, "", fmt.Errorf("create user invite: %w", err)
	}
	u.Role = Role(roleStr)
	return u, token, nil
}
```

Note: `internal/auth/invite.go` needs `"context"` imported too — add it to the `import` block above.

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/invite.go internal/auth/invite_test.go
git commit -m "feat(auth): add CreateUserInvite"
```

---

## Task 3: `GetUserByInviteToken`

**Files:**
- Modify: `internal/auth/invite.go`
- Test: `internal/auth/invite_test.go`

**Interfaces:**
- Consumes: `ErrUserNotFound` (`internal/auth/store.go:14`).
- Produces: `Store.GetUserByInviteToken(ctx, token string) (User, error)` — used by Task 4 (`ActivateUser`) and the public `GET /api/invites/{token}` handler (Task 10).

- [ ] **Step 1: Write the failing test**

```go
// internal/auth/invite_test.go — append
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestGetUserByInviteToken -v`
Expected: FAIL — `store.GetUserByInviteToken` undefined.

- [ ] **Step 3: Implement**

```go
// internal/auth/invite.go — update the import block at the top of the file
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)
```

```go
// internal/auth/invite.go — append
func (s *Store) GetUserByInviteToken(ctx context.Context, token string) (User, error) {
	var u User
	var roleStr string
	var expiresAt *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT id, username, password_hash, role, created_at, activated, invite_expires_at
		FROM users WHERE invite_token = $1`, token,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user by invite token: %w", err)
	}
	if expiresAt == nil || time.Now().After(*expiresAt) {
		return User{}, ErrInviteExpired
	}
	u.Role = Role(roleStr)
	return u, nil
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/invite.go internal/auth/invite_test.go
git commit -m "feat(auth): add GetUserByInviteToken with expiry check"
```

---

## Task 4: `ActivateUser`

**Files:**
- Modify: `internal/auth/invite.go`
- Test: `internal/auth/invite_test.go`

**Interfaces:**
- Consumes: `Store.GetUserByInviteToken`, `HashPassword` (`internal/auth/password.go:11`).
- Produces: `Store.ActivateUser(ctx, token, password string) (User, error)` — used by the `POST /api/invites/{token}` handler (Task 10).

- [ ] **Step 1: Write the failing test**

```go
// internal/auth/invite_test.go — append
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestActivateUser -v`
Expected: FAIL — `store.ActivateUser` undefined.

- [ ] **Step 3: Implement**

```go
// internal/auth/invite.go — append
func (s *Store) ActivateUser(ctx context.Context, token, password string) (User, error) {
	user, err := s.GetUserByInviteToken(ctx, token)
	if err != nil {
		return User{}, err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}

	var roleStr string
	err = s.db.QueryRow(ctx, `
		UPDATE users
		SET password_hash = $1, activated = TRUE, invite_token = NULL, invite_expires_at = NULL
		WHERE id = $2
		RETURNING id, username, password_hash, role, created_at, activated`,
		hash, user.ID,
	).Scan(&user.ID, &user.Username, &user.PasswordHash, &roleStr, &user.CreatedAt, &user.Activated)
	if err != nil {
		return User{}, fmt.Errorf("activate user: %w", err)
	}
	user.Role = Role(roleStr)
	return user, nil
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/invite.go internal/auth/invite_test.go
git commit -m "feat(auth): add ActivateUser"
```

---

## Task 5: `RegenerateInvite`

**Files:**
- Modify: `internal/auth/invite.go`
- Test: `internal/auth/invite_test.go`

**Interfaces:**
- Produces: `Store.RegenerateInvite(ctx, id string) (string, error)` — used by the `POST /api/users/{id}/invite` handler (Task 9).

- [ ] **Step 1: Write the failing test**

```go
// internal/auth/invite_test.go — append
func TestRegenerateInvite(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	user, firstToken, err := store.CreateUserInvite(ctx, "paul", RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}

	secondToken, err := store.RegenerateInvite(ctx, user.ID)
	if err != nil {
		t.Fatalf("RegenerateInvite: %v", err)
	}
	if secondToken == firstToken {
		t.Fatal("RegenerateInvite should produce a fresh token")
	}
	if _, err := store.GetUserByInviteToken(ctx, firstToken); err != ErrUserNotFound {
		t.Fatalf("got err %v, want ErrUserNotFound for the superseded token", err)
	}
	if _, err := store.GetUserByInviteToken(ctx, secondToken); err != nil {
		t.Fatalf("GetUserByInviteToken(secondToken): %v", err)
	}
}

func TestRegenerateInviteRejectsActivatedUser(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	user, err := store.CreateUser(ctx, "quinn", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if _, err := store.RegenerateInvite(ctx, user.ID); err != ErrAlreadyActivated {
		t.Fatalf("got err %v, want ErrAlreadyActivated", err)
	}
}

func TestRegenerateInviteUnknownUser(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if _, err := store.RegenerateInvite(context.Background(), "00000000-0000-0000-0000-000000000000"); err != ErrUserNotFound {
		t.Fatalf("got err %v, want ErrUserNotFound", err)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestRegenerateInvite -v`
Expected: FAIL — `store.RegenerateInvite` undefined.

- [ ] **Step 3: Implement**

```go
// internal/auth/invite.go — append
func (s *Store) RegenerateInvite(ctx context.Context, id string) (string, error) {
	var activated bool
	err := s.db.QueryRow(ctx, `SELECT activated FROM users WHERE id = $1`, id).Scan(&activated)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUserNotFound
	}
	if err != nil {
		return "", fmt.Errorf("lookup user: %w", err)
	}
	if activated {
		return "", ErrAlreadyActivated
	}

	token, err := newSessionToken()
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().Add(InviteTTL)
	if _, err := s.db.Exec(ctx, `UPDATE users SET invite_token = $1, invite_expires_at = $2 WHERE id = $3`,
		token, expiresAt, id); err != nil {
		return "", fmt.Errorf("regenerate invite: %w", err)
	}
	return token, nil
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/invite.go internal/auth/invite_test.go
git commit -m "feat(auth): add RegenerateInvite"
```

---

## Task 6: `UpdateUserRole`

**Files:**
- Modify: `internal/auth/store.go` (add near `DeleteUser`, `internal/auth/store.go:90-122`)
- Test: `internal/auth/store_test.go`

**Interfaces:**
- Produces: `Store.UpdateUserRole(ctx, id string, role Role) (User, error)` — used by the `PATCH /api/users/{id}` handler (Task 8).

- [ ] **Step 1: Write the failing test**

```go
// internal/auth/store_test.go — append
func TestUpdateUserRole(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	if _, err := store.CreateUser(ctx, "admin1", "hunter22222", RoleAdmin); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	target, err := store.CreateUser(ctx, "target", "hunter22222", RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	updated, err := store.UpdateUserRole(ctx, target.ID, RoleAdmin)
	if err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	if updated.Role != RoleAdmin {
		t.Fatalf("got role %q, want admin", updated.Role)
	}
}

func TestUpdateUserRoleRefusesDemotingLastAdmin(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	ctx := context.Background()
	admin, err := store.CreateUser(ctx, "onlyadmin2", "hunter22222", RoleAdmin)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	if _, err := store.UpdateUserRole(ctx, admin.ID, RoleUser); err != ErrLastAdmin {
		t.Fatalf("got err %v, want ErrLastAdmin", err)
	}
}

func TestUpdateUserRoleUnknownUser(t *testing.T) {
	store := NewStore(dbtest.Open(t))
	if _, err := store.UpdateUserRole(context.Background(), "00000000-0000-0000-0000-000000000000", RoleAdmin); err != ErrUserNotFound {
		t.Fatalf("got err %v, want ErrUserNotFound", err)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -run TestUpdateUserRole -v`
Expected: FAIL — `store.UpdateUserRole` undefined.

- [ ] **Step 3: Implement**

```go
// internal/auth/store.go — append, mirrors DeleteUser's transactional last-admin guard
func (s *Store) UpdateUserRole(ctx context.Context, id string, role Role) (User, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return User{}, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentRole string
	err = tx.QueryRow(ctx, `SELECT role FROM users WHERE id = $1 FOR UPDATE`, id).Scan(&currentRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("lookup user: %w", err)
	}

	if Role(currentRole) == RoleAdmin && role != RoleAdmin {
		var admins int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'admin'`).Scan(&admins); err != nil {
			return User{}, fmt.Errorf("count admins: %w", err)
		}
		if admins <= 1 {
			return User{}, ErrLastAdmin
		}
	}

	var u User
	var roleStr string
	err = tx.QueryRow(ctx, `
		UPDATE users SET role = $1 WHERE id = $2
		RETURNING id, username, password_hash, role, created_at, activated`,
		string(role), id,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
	if err != nil {
		return User{}, fmt.Errorf("update role: %w", err)
	}
	u.Role = Role(roleStr)
	if err := tx.Commit(ctx); err != nil {
		return User{}, fmt.Errorf("commit: %w", err)
	}
	return u, nil
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/auth/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/store.go internal/auth/store_test.go
git commit -m "feat(auth): add UpdateUserRole"
```

---

## Task 7: Wire `createUser` to the invite flow; extend `userResponse`

**Files:**
- Modify: `internal/httpapi/auth_handlers.go:12-25`
- Modify: `internal/httpapi/user_handlers.go:12-57`
- Modify: `internal/httpapi/auth_handlers_test.go:129,162` (existing `createUserRequest` literals lose `Password`)
- Test: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Consumes: `auth.Store.CreateUserInvite` (Task 2).
- Produces: `userResponse{ID, Username, Role, Activated, CreatedAt}`, `createUserRequest{Username, Role}`, `createUserResponse{User, InviteURL}`, `inviteURL(r *http.Request, token string) string` — the last is reused by Task 9's `regenerateInvite` handler.

- [ ] **Step 1: Write the failing test**

```go
// internal/httpapi/auth_handlers_test.go — append
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
```

Add `"strings"` to the test file's import block.

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -run TestCreateUserReturnsInviteLink -v`
Expected: FAIL — `createUserRequest` still has a required-looking `Password` field pattern elsewhere and `createUserResponse`/`resp.User.Activated`/`resp.InviteURL` don't exist yet (compile error).

- [ ] **Step 3: Update `userResponse`**

```go
// internal/httpapi/auth_handlers.go
import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/kudes1/firenet/internal/auth"
)

type userResponse struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	Activated bool   `json:"activated"`
	CreatedAt string `json:"createdAt"`
}

func toUserResponse(u auth.User) userResponse {
	return userResponse{
		ID:        u.ID,
		Username:  u.Username,
		Role:      string(u.Role),
		Activated: u.Activated,
		CreatedAt: u.CreatedAt.Format(time.RFC3339),
	}
}
```

- [ ] **Step 4: Rewrite `createUser`**

```go
// internal/httpapi/user_handlers.go
type createUserRequest struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type createUserResponse struct {
	User      userResponse `json:"user"`
	InviteURL string       `json:"inviteUrl"`
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
	if req.Username == "" {
		writeError(w, http.StatusBadRequest, errors.New("username is required"))
		return
	}

	user, token, err := h.users.CreateUserInvite(r.Context(), req.Username, role)
	if err != nil {
		if errors.Is(err, auth.ErrUsernameTaken) {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, createUserResponse{User: toUserResponse(user), InviteURL: inviteURL(r, token)})
}

// inviteURL builds the public link an admin copies for an invited user.
// No reverse-proxy header handling (X-Forwarded-Proto etc.) — nothing
// else in this codebase does that either.
func inviteURL(r *http.Request, token string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/invite/" + token
}
```

- [ ] **Step 5: Fix the two existing tests that construct the old `createUserRequest` shape**

```go
// internal/httpapi/auth_handlers_test.go — TestCreateAndListUsersAsAdmin
	body, _ := json.Marshal(createUserRequest{Username: "ivan", Role: "user"})
```

```go
// internal/httpapi/auth_handlers_test.go — TestCreateUserAsNonAdminIsForbidden
	body, _ := json.Marshal(createUserRequest{Username: "someone", Role: "user"})
```

- [ ] **Step 6: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -v`
Expected: PASS — all `internal/httpapi` tests, including the two fixed ones and the new one.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/auth_handlers.go internal/httpapi/user_handlers.go internal/httpapi/auth_handlers_test.go
git commit -m "feat(httpapi): create users via invite link instead of admin-set password"
```

---

## Task 8: `PATCH /api/users/{id}` — role editing

**Files:**
- Modify: `internal/httpapi/user_handlers.go`
- Modify: `internal/httpapi/server.go:26-28`
- Test: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Consumes: `auth.Store.UpdateUserRole` (Task 6), `auth.UserFromContext` (`internal/auth/middleware.go:38`).
- Produces: route `PATCH /api/users/{id}` → `h.updateUser`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/httpapi/auth_handlers_test.go — append
func TestUpdateUserRoleAsAdmin(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	target, err := users.CreateUser(context.Background(), "sam", "hunter22222", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	body, _ := json.Marshal(updateUserRequest{Role: "admin"})
	req := httptest.NewRequest(http.MethodPatch, "/api/users/"+target.ID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var updated userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if updated.Role != "admin" {
		t.Fatalf("got role %q, want admin", updated.Role)
	}
}

func TestUpdateOwnRoleIsRejected(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")
	adminID := mustBootstrapAdminID(t, users)

	body, _ := json.Marshal(updateUserRequest{Role: "user"})
	req := httptest.NewRequest(http.MethodPatch, "/api/users/"+adminID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -run TestUpdateUserRole -v`
Expected: FAIL — `updateUserRequest` undefined, route returns 404/405.

- [ ] **Step 3: Implement the handler**

```go
// internal/httpapi/user_handlers.go — append
type updateUserRequest struct {
	Role string `json:"role"`
}

func (h *handlers) updateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if currentUser, ok := auth.UserFromContext(r.Context()); ok && id == currentUser.ID {
		writeError(w, http.StatusBadRequest, errors.New("cannot change your own role"))
		return
	}

	var req updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	role := auth.Role(req.Role)
	if role != auth.RoleAdmin && role != auth.RoleUser {
		writeError(w, http.StatusBadRequest, fmt.Errorf("role must be %q or %q", auth.RoleAdmin, auth.RoleUser))
		return
	}

	user, err := h.users.UpdateUserRole(r.Context(), id, role)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, toUserResponse(user))
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrLastAdmin):
		writeError(w, http.StatusBadRequest, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}
```

- [ ] **Step 4: Register the route**

```go
// internal/httpapi/server.go — next to the other /api/users routes
	apiMux.Handle("PATCH /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.updateUser)))
```

- [ ] **Step 5: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/user_handlers.go internal/httpapi/server.go internal/httpapi/auth_handlers_test.go
git commit -m "feat(httpapi): add PATCH /api/users/{id} for role editing"
```

---

## Task 9: `POST /api/users/{id}/invite` — regenerate a pending invite

**Files:**
- Modify: `internal/httpapi/user_handlers.go`
- Modify: `internal/httpapi/server.go:26-28`
- Test: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Consumes: `auth.Store.RegenerateInvite` (Task 5), `inviteURL` (Task 7).
- Produces: route `POST /api/users/{id}/invite` → `h.regenerateInvite`, `inviteURLResponse{InviteURL}`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/httpapi/auth_handlers_test.go — append
func TestRegenerateInviteAsAdmin(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	pending, _, err := users.CreateUserInvite(context.Background(), "tara", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUserInvite: %v", err)
	}
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	req := httptest.NewRequest(http.MethodPost, "/api/users/"+pending.ID+"/invite", nil)
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200; body: %s", rec.Code, rec.Body.String())
	}
	var resp inviteURLResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(resp.InviteURL, "/invite/") {
		t.Fatalf("inviteUrl = %q, want it to contain /invite/", resp.InviteURL)
	}
}

func TestRegenerateInviteForActivatedUserIsRejected(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	active, err := users.CreateUser(context.Background(), "uma", "hunter22222", auth.RoleUser)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	adminCookie := loginAndGetCookie(t, srv, "admin", "test-password-1")

	req := httptest.NewRequest(http.MethodPost, "/api/users/"+active.ID+"/invite", nil)
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -run TestRegenerateInvite -v`
Expected: FAIL — route not registered (404), `inviteURLResponse` undefined.

- [ ] **Step 3: Implement**

```go
// internal/httpapi/user_handlers.go — append
type inviteURLResponse struct {
	InviteURL string `json:"inviteUrl"`
}

func (h *handlers) regenerateInvite(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token, err := h.users.RegenerateInvite(r.Context(), id)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, inviteURLResponse{InviteURL: inviteURL(r, token)})
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrAlreadyActivated):
		writeError(w, http.StatusBadRequest, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}
```

- [ ] **Step 4: Register the route**

```go
// internal/httpapi/server.go
	apiMux.Handle("POST /api/users/{id}/invite", auth.RequireAdmin(http.HandlerFunc(h.regenerateInvite)))
```

- [ ] **Step 5: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/user_handlers.go internal/httpapi/server.go internal/httpapi/auth_handlers_test.go
git commit -m "feat(httpapi): add POST /api/users/{id}/invite to regenerate a pending invite"
```

---

## Task 10: Public invite endpoints + `/invite/{token}` page route

**Files:**
- Create: `internal/httpapi/invite_handlers.go`
- Modify: `internal/httpapi/server.go` (public routes, next to `/api/login`; UI route next to `/login`)
- Test: `internal/httpapi/invite_handlers_test.go`

**Interfaces:**
- Consumes: `auth.Store.GetUserByInviteToken` (Task 3), `auth.Store.ActivateUser` (Task 4).
- Produces: routes `GET /api/invites/{token}`, `POST /api/invites/{token}`, `GET /invite/{token}` (serves `invite.html`, built in Task 14).

- [ ] **Step 1: Write the failing tests**

```go
// internal/httpapi/invite_handlers_test.go
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -run 'TestGetInvite|TestAcceptInvite|TestInvitePage' -v`
Expected: FAIL — none of these routes/types exist yet.

- [ ] **Step 3: Implement the handlers**

```go
// internal/httpapi/invite_handlers.go
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type inviteInfoResponse struct {
	Username string `json:"username"`
}

// getInvite is public: an invited user isn't logged in yet.
func (h *handlers) getInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	user, err := h.users.GetUserByInviteToken(r.Context(), token)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, inviteInfoResponse{Username: user.Username})
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrInviteExpired):
		writeError(w, http.StatusGone, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

type acceptInviteRequest struct {
	Password        string `json:"password"`
	ConfirmPassword string `json:"confirmPassword"`
}

// acceptInvite is public, same reasoning as getInvite.
func (h *handlers) acceptInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	var req acceptInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, errors.New("password must be at least 8 characters"))
		return
	}
	if req.Password != req.ConfirmPassword {
		writeError(w, http.StatusBadRequest, errors.New("passwords do not match"))
		return
	}

	_, err := h.users.ActivateUser(r.Context(), token, req.Password)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, auth.ErrUserNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, auth.ErrInviteExpired):
		writeError(w, http.StatusGone, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}
```

- [ ] **Step 4: Register the routes**

```go
// internal/httpapi/server.go — next to POST /api/login / POST /api/logout,
// i.e. public, registered on mux (not apiMux) before the auth-wrapped block
	mux.HandleFunc("GET /api/invites/{token}", h.getInvite)
	mux.HandleFunc("POST /api/invites/{token}", h.acceptInvite)
```

```go
// internal/httpapi/server.go — next to GET /login
	mux.HandleFunc("GET /invite/{token}", servePage("invite.html"))
```

`servePage("invite.html")` will 404 until Task 14 adds that file — acceptable for this task since `TestInvitePageIsPubliclyServed` only needs `servePage`'s route itself to be reachable and return whatever the embedded FS currently has at that path once Task 14 lands; for now, temporarily create a one-line placeholder so this task's test passes standalone (Task 14 replaces its contents):

```html
<!-- internal/httpapi/web/invite.html — placeholder, replaced in Task 14 -->
<!doctype html><html><body></body></html>
```

- [ ] **Step 5: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/invite_handlers.go internal/httpapi/invite_handlers_test.go internal/httpapi/server.go internal/httpapi/web/invite.html
git commit -m "feat(httpapi): add public invite-acceptance endpoints and page route"
```

---

## Task 11: Self-delete guard on `deleteUser`

**Files:**
- Modify: `internal/httpapi/user_handlers.go:59-72`
- Test: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Consumes: `auth.UserFromContext`.

- [ ] **Step 1: Write the failing test**

```go
// internal/httpapi/auth_handlers_test.go — append
func TestDeleteSelfIsRejected(t *testing.T) {
	srv, users := newUnauthenticatedTestServer(t)
	// A second admin exists so this isn't blocked by ErrLastAdmin instead —
	// we want to isolate the self-delete guard.
	if _, err := users.CreateUser(context.Background(), "admin2", "hunter22222", auth.RoleAdmin); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -run TestDeleteSelfIsRejected -v`
Expected: FAIL — currently succeeds with 204 (two admins exist, so `ErrLastAdmin` doesn't fire).

- [ ] **Step 3: Implement**

```go
// internal/httpapi/user_handlers.go
func (h *handlers) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if currentUser, ok := auth.UserFromContext(r.Context()); ok && id == currentUser.ID {
		writeError(w, http.StatusBadRequest, errors.New("cannot delete your own account"))
		return
	}
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./internal/httpapi/... -v`
Expected: PASS — full `internal/httpapi` and `internal/auth` suites green.

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/user_handlers.go internal/httpapi/auth_handlers_test.go
git commit -m "feat(httpapi): refuse to let an admin delete their own account"
```

---

## Task 12: `Api.patch` in `common.js`

**Files:**
- Modify: `internal/httpapi/web/common.js:198-233`

**Interfaces:**
- Produces: `Api.patch(path, body)` — used by `users.js` (Task 13).

- [ ] **Step 1: Implement**

```js
// internal/httpapi/web/common.js — inside the Api object, next to put()
  async patch(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (lastDraftRevision) headers["X-Draft-Revision"] = lastDraftRevision;
    const res = await fetch(path, { method: "PATCH", headers, body: JSON.stringify(body) });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    const rev = res.headers?.get("X-Draft-Revision");
    if (rev) lastDraftRevision = rev;
    return res.status === 204 ? null : res.json();
  },
```

This mirrors `put()` immediately above it exactly, just with `method: "PATCH"`. No dedicated test here — it's exercised end-to-end by `users_page.test.js` in Task 13, the same way `devices_page.test.js` exercises `Api.post` without a standalone `Api` test.

- [ ] **Step 2: Commit**

```bash
git add internal/httpapi/web/common.js
git commit -m "feat(web): add Api.patch"
```

---

## Task 13: Rewrite `users.html`/`users.js` in the app's Alpine design system

**Files:**
- Modify: `internal/httpapi/web/users.html` (full rewrite)
- Modify: `internal/httpapi/web/users.js` (full rewrite)
- Test: `internal/httpapi/web/users_page.test.js` (new)

**Interfaces:**
- Consumes: `Api` (`.get`, `.post`, `.patch`, `.delete`), `showBanner`, `containsFold` (`internal/httpapi/web/common.js`), `initializeColumns`, `makeColumnsResizable` (`internal/httpapi/web/columns.js`).
- Produces: Alpine component `usersPage` with `users`, `currentUserId`, `loaded`, `filters`, `searchOpen`, `filteredUsers`, `createDraft`, `createHint`, `editDraft`, `inviteUrl`, `inviteUsername`, and methods `init`, `openCreate`, `submitCreate`, `openEdit`, `submitEdit`, `openInviteFor`, `copyInviteUrl`, `removeUser`, `formatDate` — this is the full public surface other tasks (none) or a future page would call into.

- [ ] **Step 1: Write the failing test file**

```js
// internal/httpapi/web/users_page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  let usersFixture = [
    { id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "u2", username: "pending-guy", role: "user", activated: false, createdAt: "2026-01-02T00:00:00Z" },
  ];
  global.document = {
    addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn),
  };
  global.window = { dispatchEvent: notify };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  global.confirm = () => true;
  global.navigator = { clipboard: { writeText: async (text) => { calls.push({ path: "clipboard.writeText", text }); } } };
  global.fetch = async (path_, opts) => {
    calls.push({ path: path_, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    if (path_ === "/api/users" && (!opts || !opts.method)) {
      return { ok: true, status: 200, json: async () => usersFixture };
    }
    if (path_ === "/api/me") {
      return { ok: true, status: 200, json: async () => ({ id: "u1", username: "admin", role: "admin" }) };
    }
    if (path_ === "/api/users" && opts?.method === "POST") {
      const req = JSON.parse(opts.body);
      const created = { id: "u3", username: req.username, role: req.role, activated: false, createdAt: "2026-01-03T00:00:00Z" };
      usersFixture = [...usersFixture, created];
      return { ok: true, status: 201, json: async () => ({ user: created, inviteUrl: "https://firenet.example/invite/tok3" }) };
    }
    if (path_ === "/api/users/u2/invite" && opts?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ inviteUrl: "https://firenet.example/invite/tok2b" }) };
    }
    if (path_ === "/api/users/u2" && opts?.method === "PATCH") {
      const req = JSON.parse(opts.body);
      const updated = { ...usersFixture.find((u) => u.id === "u2"), role: req.role };
      usersFixture = usersFixture.map((u) => (u.id === "u2" ? updated : u));
      return { ok: true, status: 200, json: async () => updated };
    }
    if (path_ === "/api/users/u2" && opts?.method === "DELETE") {
      usersFixture = usersFixture.filter((u) => u.id !== "u2");
      return { ok: true, status: 204, json: async () => null };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  await import(path.join(__dirname, "users.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.usersPage();
  page.$nextTick = (fn) => fn();
  page.$refs = {
    table: null,
    createDialog: { showModal: () => calls.push({ path: "createDialog.showModal" }), close: () => calls.push({ path: "createDialog.close" }) },
    editDialog: { showModal: () => calls.push({ path: "editDialog.showModal" }), close: () => calls.push({ path: "editDialog.close" }) },
    inviteDialog: { showModal: () => calls.push({ path: "inviteDialog.showModal" }), close: () => calls.push({ path: "inviteDialog.close" }) },
  };
  return { page, calls, banners, getFixture: () => usersFixture };
}

async function bootLoadedPage() {
  const ctx = await bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads users and the current user id", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.users.length, 2);
  assert.equal(page.currentUserId, "u1");
  assert.equal(page.loaded, true);
});

test("createHint requires a unique non-empty username", async () => {
  const { page } = await bootLoadedPage();
  page.createDraft = { username: "", role: "user" };
  assert.match(page.createHint, /Укажите логин/);

  page.createDraft = { username: "admin", role: "user" };
  assert.match(page.createHint, /уже используется/);

  page.createDraft = { username: "newperson", role: "user" };
  assert.equal(page.createHint, "");
});

test("submitCreate posts the invite request and opens the invite modal", async () => {
  const { page, calls } = await bootLoadedPage();
  page.createDraft = { username: "newperson", role: "user" };

  await page.submitCreate();

  const post = calls.find((c) => c.path === "/api/users" && c.method === "POST");
  assert.deepEqual(post.body, { username: "newperson", role: "user" });
  assert.equal(page.inviteUrl, "https://firenet.example/invite/tok3");
  assert.equal(page.inviteUsername, "newperson");
  assert.ok(calls.some((c) => c.path === "createDialog.close"));
  assert.ok(calls.some((c) => c.path === "inviteDialog.showModal"));
  assert.equal(page.users.length, 3);
});

test("openInviteFor regenerates a link for a pending user", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.openInviteFor(page.users.find((u) => u.id === "u2"));

  assert.ok(calls.some((c) => c.path === "/api/users/u2/invite" && c.method === "POST"));
  assert.equal(page.inviteUrl, "https://firenet.example/invite/tok2b");
  assert.equal(page.inviteUsername, "pending-guy");
  assert.ok(calls.some((c) => c.path === "inviteDialog.showModal"));
});

test("copyInviteUrl writes the current invite link to the clipboard", async () => {
  const { page, calls } = await bootLoadedPage();
  page.inviteUrl = "https://firenet.example/invite/tokX";

  await page.copyInviteUrl();

  assert.ok(calls.some((c) => c.path === "clipboard.writeText" && c.text === "https://firenet.example/invite/tokX"));
});

test("submitEdit patches the role and updates the local row", async () => {
  const { page, calls } = await bootLoadedPage();
  page.editDraft = { id: "u2", username: "pending-guy", role: "admin" };

  await page.submitEdit();

  const patch = calls.find((c) => c.path === "/api/users/u2" && c.method === "PATCH");
  assert.deepEqual(patch.body, { role: "admin" });
  assert.equal(page.users.find((u) => u.id === "u2").role, "admin");
  assert.ok(calls.some((c) => c.path === "editDialog.close"));
});

test("removeUser deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeUser(page.users.find((u) => u.id === "u2"));

  assert.ok(calls.some((c) => c.path === "/api/users/u2" && c.method === "DELETE"));
  assert.deepEqual(page.users.map((u) => u.id), ["u1"]);
});

test("filteredUsers matches by username", async () => {
  const { page } = await bootLoadedPage();

  page.filters.username = "pending";
  assert.deepEqual(page.filteredUsers.map((u) => u.id), ["u2"]);

  page.filters.username = "";
  assert.deepEqual(page.filteredUsers.map((u) => u.id), ["u1", "u2"]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test internal/httpapi/web/users_page.test.js`
Expected: FAIL — `users.js` doesn't register an `alpine:init` listener or a `usersPage` Alpine component yet (it's still the old vanilla-DOM version).

- [ ] **Step 3: Rewrite `users.js`**

```js
// internal/httpapi/web/users.js
"use strict";

import { Api, showBanner, containsFold } from "./common.js";
import { makeColumnsResizable, initializeColumns } from "./columns.js";

const USERS_COL_WIDTHS_KEY = "firenet-users-col-widths-v1";
const USERS_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("usersPage", () => ({
    users: [], // {id, username, role, activated, createdAt}
    currentUserId: "",
    loaded: false,
    saving: false,
    filters: { username: "" },
    searchOpen: false,
    createDraft: { username: "", role: "user" },
    editDraft: { id: "", username: "", role: "user" },
    inviteUrl: "",
    inviteUsername: "",

    async init() {
      try {
        const [users, me] = await Promise.all([Api.get("/api/users"), Api.get("/api/me")]);
        this.users = users;
        this.currentUserId = me.id;
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить пользователей: " + e.message);
      }
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, USERS_COL_WIDTHS_KEY, USERS_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, USERS_COL_WIDTHS_KEY, USERS_COL_WIDTHS_VERSION);
    },

    get filteredUsers() {
      return this.users.filter((u) => containsFold(u.username, this.filters.username));
    },

    formatDate(iso) {
      return new Date(iso).toLocaleDateString("ru-RU");
    },

    openCreate() {
      this.createDraft = { username: "", role: "user" };
      this.$refs.createDialog.showModal();
    },

    get createHint() {
      const name = this.createDraft.username.trim();
      if (!name) return "Укажите логин";
      if (this.users.some((u) => u.username === name)) return `Логин ${name} уже используется`;
      return "";
    },

    async submitCreate() {
      if (this.createHint || this.saving) return;
      this.saving = true;
      try {
        const { user, inviteUrl } = await Api.post("/api/users", {
          username: this.createDraft.username.trim(),
          role: this.createDraft.role,
        });
        this.users.push(user);
        this.$refs.createDialog.close();
        this.showInvite(user.username, inviteUrl);
        showBanner("Пользователь создан", "ok");
      } catch (e) {
        showBanner("Ошибка создания: " + e.message);
      } finally {
        this.saving = false;
      }
    },

    openEdit(u) {
      this.editDraft = { id: u.id, username: u.username, role: u.role };
      this.$refs.editDialog.showModal();
    },

    async submitEdit() {
      if (this.saving) return;
      this.saving = true;
      try {
        const updated = await Api.patch(`/api/users/${this.editDraft.id}`, { role: this.editDraft.role });
        const i = this.users.findIndex((u) => u.id === updated.id);
        if (i >= 0) this.users[i] = updated;
        this.$refs.editDialog.close();
        showBanner("Роль обновлена", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      } finally {
        this.saving = false;
      }
    },

    async openInviteFor(u) {
      try {
        const { inviteUrl } = await Api.post(`/api/users/${u.id}/invite`, {});
        this.showInvite(u.username, inviteUrl);
      } catch (e) {
        showBanner("Не удалось получить ссылку: " + e.message);
      }
    },

    showInvite(username, url) {
      this.inviteUsername = username;
      this.inviteUrl = url;
      this.$refs.inviteDialog.showModal();
    },

    async copyInviteUrl() {
      try {
        await navigator.clipboard.writeText(this.inviteUrl);
        showBanner("Ссылка скопирована", "ok");
      } catch (e) {
        showBanner("Не удалось скопировать: " + e.message);
      }
    },

    async removeUser(u) {
      if (!confirm(`Удалить пользователя «${u.username}»?`)) return;
      try {
        await Api.delete(`/api/users/${u.id}`);
        this.users = this.users.filter((x) => x.id !== u.id);
        showBanner("Пользователь удалён", "ok");
      } catch (e) {
        showBanner("Ошибка удаления: " + e.message);
      }
    },
  }));
});
```

- [ ] **Step 4: Rewrite `users.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>firenet — пользователи</title>
<script>
  try {
    var saved = localStorage.getItem("firenet-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="users" data-no-draft-banner="true" x-data="appData()" @notify.window="showBanner($event.detail.message, $event.detail.kind)">

<main x-data="usersPage">
  <div class="table-toolbar">
    <div class="toolbar-text">
      <h3>Пользователи</h3>
      <p class="hint">Учётные записи с доступом к firenet. Новый пользователь получает временную ссылку — по ней он сам задаёт себе пароль.</p>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="secondary btn-search" @click="searchOpen = !searchOpen" title="Поиск по логину"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25"/><path d="m13.2 13.2-4.3-4.3"/></svg></button>
      <button type="button" class="primary" @click="openCreate()">Добавить пользователя</button>
    </div>
  </div>
  <div class="table-wrap" x-show="loaded" x-cloak>
    <table class="data-table" x-ref="table">
      <colgroup>
        <col data-default-width="200" data-min-width="120">
        <col data-default-width="100" data-min-width="80">
        <col data-default-width="120" data-min-width="90">
        <col data-default-width="160" data-min-width="120">
        <col data-default-width="90" data-min-width="80">
      </colgroup>
      <thead>
        <tr><th>Логин</th><th>Роль</th><th>Статус</th><th>Создан</th><th></th></tr>
        <tr class="search-row" x-show="searchOpen" x-cloak>
          <th><input x-model.trim="filters.username" placeholder="поиск..."></th>
          <th></th><th></th><th></th>
          <th><button type="button" class="icon-btn reset-search" title="Сбросить фильтры" @click="filters.username = ''">&#10005;</button></th>
        </tr>
      </thead>
      <tbody>
        <template x-for="u in filteredUsers" :key="u.id">
          <tr>
            <td x-text="u.username"></td>
            <td x-text="u.role === 'admin' ? 'admin' : 'user'"></td>
            <td><span class="badge" :class="u.activated ? 'badge-ok' : 'badge-warn'" x-text="u.activated ? 'Активен' : 'Ожидает'"></span></td>
            <td x-text="formatDate(u.createdAt)"></td>
            <td>
              <button type="button" class="icon-btn edit" title="Изменить роль" x-show="u.id !== currentUserId" @click="openEdit(u)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.1a1.6 1.6 0 0 1 2.3 2.3L5.4 12.6l-3.1.8.8-3.1z"/></svg></button>
              <button type="button" class="icon-btn" title="Показать ссылку" x-show="!u.activated" @click="openInviteFor(u)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l1.5-1.5a2.5 2.5 0 1 0-3.5-3.5L7 5.5"/><path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0L4.5 8a2.5 2.5 0 1 0 3.5 3.5L9 10.5"/></svg></button>
              <button type="button" class="icon-btn delete" title="Удалить" x-show="u.id !== currentUserId" @click="removeUser(u)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11"/><path d="M5.5 4V2.7c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4"/><path d="M3.5 4l.6 9.3c0 .4.4.7.8.7h6.2c.4 0 .8-.3.8-.7L12.5 4"/><path d="M6.5 6.8v4.4"/><path d="M9.5 6.8v4.4"/></svg></button>
            </td>
          </tr>
        </template>
        <tr x-show="loaded && !users.length"><td colspan="5" class="empty-cell">Пользователей нет</td></tr>
        <tr x-show="loaded && users.length && !filteredUsers.length"><td colspan="5" class="empty-cell">Ничего не найдено</td></tr>
      </tbody>
    </table>
  </div>

  <dialog x-ref="createDialog" class="modal">
    <h3>Новый пользователь</h3>
    <label>Логин
      <input x-model.trim="createDraft.username" placeholder="ivan">
    </label>
    <label>Роль
      <select x-model="createDraft.role">
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
    </label>
    <p class="cell-hint" x-show="createHint" x-text="createHint"></p>
    <div class="modal-actions">
      <button type="button" @click="$refs.createDialog.close()">Отмена</button>
      <button type="button" class="primary" :disabled="!!createHint || saving" @click="submitCreate()">Создать</button>
    </div>
  </dialog>

  <dialog x-ref="editDialog" class="modal">
    <h3>Роль пользователя «<span x-text="editDraft.username"></span>»</h3>
    <label>Роль
      <select x-model="editDraft.role">
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" @click="$refs.editDialog.close()">Отмена</button>
      <button type="button" class="primary" :disabled="saving" @click="submitEdit()">Сохранить</button>
    </div>
  </dialog>

  <dialog x-ref="inviteDialog" class="modal">
    <h3>Ссылка для активации</h3>
    <p class="hint">Отправьте эту ссылку пользователю «<span x-text="inviteUsername"></span>» — она действительна 24 часа и показывается только один раз.</p>
    <label>Ссылка
      <input type="text" readonly :value="inviteUrl" @click="$event.target.select()">
    </label>
    <div class="modal-actions">
      <button type="button" @click="$refs.inviteDialog.close()">Закрыть</button>
      <button type="button" class="primary" @click="copyInviteUrl()">Копировать</button>
    </div>
  </dialog>
</main>

<script type="module" src="/common.js"></script>
<script type="module" src="/users.js"></script>
<script src="/alpine.min.js" defer></script>
</body>
</html>
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test internal/httpapi/web/users_page.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/users.html internal/httpapi/web/users.js internal/httpapi/web/users_page.test.js
git commit -m "feat(web): redesign users page with invite-link creation and role editing"
```

---

## Task 14: `invite.html`/`invite.js` — the public "set your password" page

**Files:**
- Modify: `internal/httpapi/web/invite.html` (replace Task 10's placeholder)
- Create: `internal/httpapi/web/invite.js`
- Test: `internal/httpapi/web/invite_page.test.js` (new)

**Interfaces:**
- Produces: `tokenFromPath(pathname)`, `validatePasswords(password, confirmPassword)` — pure, exported functions, tested directly (mirroring how `login.test.js` only exercises `login.js`'s exported `loginRedirectTarget`, not its `DOMContentLoaded` wiring).

- [ ] **Step 1: Write the failing test**

```js
// internal/httpapi/web/invite_page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  global.document = { addEventListener() {} };
  const { tokenFromPath, validatePasswords } = await import(path.join(__dirname, "invite.js"));

  test("tokenFromPath extracts the token from /invite/{token}", () => {
    assert.equal(tokenFromPath("/invite/abc123"), "abc123");
  });

  test("tokenFromPath returns empty string for an unrelated path", () => {
    assert.equal(tokenFromPath("/login"), "");
  });

  test("validatePasswords rejects a too-short password", () => {
    assert.match(validatePasswords("short", "short"), /не менее 8/);
  });

  test("validatePasswords rejects a mismatch", () => {
    assert.match(validatePasswords("longenough1", "different1"), /не совпадают/);
  });

  test("validatePasswords accepts a matching, long-enough pair", () => {
    assert.equal(validatePasswords("longenough1", "longenough1"), "");
  });
})();
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test internal/httpapi/web/invite_page.test.js`
Expected: FAIL — `internal/httpapi/web/invite.js` doesn't exist yet.

- [ ] **Step 3: Write `invite.js`**

```js
// internal/httpapi/web/invite.js
"use strict";

export function tokenFromPath(pathname) {
  const m = pathname.match(/^\/invite\/([^/]+)$/);
  return m ? m[1] : "";
}

export function validatePasswords(password, confirmPassword) {
  if (password.length < 8) return "Пароль должен содержать не менее 8 символов";
  if (password !== confirmPassword) return "Пароли не совпадают";
  return "";
}

document.addEventListener("DOMContentLoaded", async () => {
  document.documentElement.dataset.theme =
    localStorage.getItem("firenet-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const token = tokenFromPath(window.location.pathname);
  const loadingEl = document.getElementById("invite-loading");
  const invalidEl = document.getElementById("invite-invalid");
  const form = document.getElementById("invite-form");
  const greetingEl = document.getElementById("invite-greeting");
  const errorEl = document.getElementById("invite-error");

  const res = await fetch(`/api/invites/${token}`);
  loadingEl.hidden = true;
  if (!res.ok) {
    invalidEl.hidden = false;
    return;
  }
  const { username } = await res.json();
  greetingEl.textContent = `Здравствуйте, ${username}! Задайте пароль для входа.`;
  form.hidden = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    const validationError = validatePasswords(password, confirmPassword);
    if (validationError) {
      errorEl.textContent = validationError;
      errorEl.hidden = false;
      return;
    }

    const submitRes = await fetch(`/api/invites/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, confirmPassword }),
    });
    if (!submitRes.ok) {
      errorEl.textContent = "Не удалось установить пароль. Попробуйте ещё раз или обратитесь к администратору.";
      errorEl.hidden = false;
      return;
    }
    window.location.href = "/login?activated=1";
  });
});
```

- [ ] **Step 4: Write `invite.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet — активация</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body class="login-page">
<main class="login-card">
  <h1>firenet</h1>
  <p id="invite-loading">Проверяем ссылку…</p>
  <p id="invite-invalid" hidden>Ссылка недействительна или истекла. Обратитесь к администратору за новой ссылкой.</p>
  <form id="invite-form" hidden>
    <p id="invite-greeting"></p>
    <label>Новый пароль
      <input type="password" name="password" autocomplete="new-password" minlength="8" required>
    </label>
    <label>Подтверждение пароля
      <input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required>
    </label>
    <button type="submit">Задать пароль</button>
    <p id="invite-error" class="login-error" hidden></p>
  </form>
</main>
<script type="module" src="/invite.js"></script>
</body>
</html>
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test internal/httpapi/web/invite_page.test.js`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add internal/httpapi/web/invite.html internal/httpapi/web/invite.js internal/httpapi/web/invite_page.test.js
git commit -m "feat(web): add the public invite-acceptance page"
```

---

## Task 15: Success notice on `/login` after activation

**Files:**
- Modify: `internal/httpapi/web/login.html`
- Modify: `internal/httpapi/web/login.js`
- Modify: `internal/httpapi/web/style.css` (near `.login-error`, `internal/httpapi/web/style.css:1190`)
- Test: `internal/httpapi/web/login.test.js`

**Interfaces:**
- Produces: `activatedNoticeVisible(search)`, exported alongside `loginRedirectTarget` from `login.js`.

- [ ] **Step 1: Write the failing test**

```js
// internal/httpapi/web/login.test.js — extend the existing import and add tests
  const { loginRedirectTarget, activatedNoticeVisible } = await import(path.join(__dirname, "login.js"));

  test("activatedNoticeVisible is true right after activation", () => {
    assert.equal(activatedNoticeVisible("?activated=1"), true);
  });

  test("activatedNoticeVisible is false otherwise", () => {
    assert.equal(activatedNoticeVisible(""), false);
    assert.equal(activatedNoticeVisible("?next=%2Fui%2Frules"), false);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test internal/httpapi/web/login.test.js`
Expected: FAIL — `activatedNoticeVisible` isn't exported by `login.js` yet.

- [ ] **Step 3: Implement in `login.js`**

```js
// internal/httpapi/web/login.js — export next to loginRedirectTarget
export function activatedNoticeVisible(search) {
  return new URLSearchParams(search).get("activated") === "1";
}
```

```js
// internal/httpapi/web/login.js — inside the DOMContentLoaded handler, after grabbing errorEl
  const noticeEl = document.getElementById("login-notice");
  if (activatedNoticeVisible(window.location.search)) {
    noticeEl.hidden = false;
  }
```

- [ ] **Step 4: Add the notice element to `login.html`**

```html
<!-- internal/httpapi/web/login.html — right after the <button type="submit">Войти</button> line -->
    <p id="login-notice" class="login-notice" hidden>Пароль установлен — теперь войдите с новым паролем.</p>
```

- [ ] **Step 5: Add the CSS**

```css
/* internal/httpapi/web/style.css — right after .login-error */
.login-notice {
  margin-top: 12px;
  color: #16a34a;
  font-size: 0.85em;
}
```

- [ ] **Step 6: Run it to see it pass**

Run: `node --test internal/httpapi/web/login.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/httpapi/web/login.html internal/httpapi/web/login.js internal/httpapi/web/style.css internal/httpapi/web/login.test.js
git commit -m "feat(web): show a success notice on /login after invite activation"
```

---

## Task 16: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full Go suite**

Run: `FIRENET_TEST_DATABASE_URL=<url> go test ./...`
Expected: PASS, no failures anywhere (including packages untouched by this plan).

- [ ] **Step 2: Run `go vet`**

Run: `go vet ./...`
Expected: clean.

- [ ] **Step 3: Run the full JS suite**

Run: `node --test 'internal/httpapi/web/*.test.js'`
Expected: PASS, no failures anywhere.

- [ ] **Step 4: gofmt check**

Run: `gofmt -l .`
Expected: no output (nothing unformatted).

- [ ] **Step 5: Commit (only if any of the above needed a fix)**

```bash
git add -A
git commit -m "chore: fix issues found by full-suite verification"
```

If everything already passed in Steps 1-4, skip this commit — there's nothing to commit.

---

## Self-Review Notes

- **Spec coverage:** migration/data model → Task 1; `CreateUserInvite`/`RegenerateInvite`/`GetUserByInviteToken`/`ActivateUser`/`UpdateUserRole` → Tasks 2–6; `userResponse` extension + `createUser` → Task 7; `updateUser` → Task 8; `regenerateInvite` → Task 9; public invite endpoints + `/invite/{token}` route → Task 10; self-delete guard → Task 11; `users.html`/`users.js` redesign → Tasks 12–13; `invite.html`/`invite.js` → Task 14; `/login` redirect-with-notice → Task 15. All spec sections are covered.
- **Placeholder scan:** no TBDs; the only intentionally temporary artifact is the one-line `invite.html` stub in Task 10, which is explicitly replaced by real content in Task 14 (not a placeholder left dangling — every task after it treats the file as real).
- **Type consistency:** `userResponse{ID, Username, Role, Activated, CreatedAt}` (Task 7) is the single shape referenced by every later Go handler test and by `users.js`'s expectations of `{id, username, role, activated, createdAt}` (Task 13) — field names match `encoding/json`'s default lowerCamelCase-from-Go-name behavior isn't used here since explicit `json:"..."` tags are given on every field, so the Go and JS shapes line up exactly. `inviteURLResponse{InviteURL}` (Task 9) and `createUserResponse.InviteURL` (Task 7) both serialize to `inviteUrl`, matching `users.js`'s destructuring of `{ inviteUrl }` in both `submitCreate` and `openInviteFor`.
