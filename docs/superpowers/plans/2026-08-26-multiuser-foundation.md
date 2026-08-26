# Multi-user Foundation (auth + Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require login for `firenet serve`, backed by a Postgres-based user/session store with `admin`/`user` roles, and ship a docker-compose setup that runs the app together with Postgres.

**Architecture:** A new `internal/db` package owns the Postgres connection pool and an embedded SQL migration runner. A new `internal/auth` package owns users, sessions, password hashing, and HTTP middleware (`RequireAuth`, `RequireAdmin`), backed by that pool. `internal/httpapi` gains login/logout/me/user-admin handlers and wraps all existing `/api/*` routes behind `RequireAuth`. The web UI gains a login page and a user badge/logout control in the existing sidebar. Project content (`topology.yaml` etc.) keeps using `FileProjectStore` unchanged in this plan — replacing it with Postgres-backed versioning is a separate, later plan.

**Tech Stack:** Go 1.23, `github.com/jackc/pgx/v5` (pgxpool), `golang.org/x/crypto/bcrypt`, PostgreSQL 16, Docker/docker-compose. No new JS dependencies — same vanilla-JS + htmx/Alpine stack already in `internal/httpapi/web`.

**Spec:** `docs/superpowers/specs/2026-08-26-multiuser-collab-design.md` (this plan implements its "Права и ошибки" auth rules and the `users`/`sessions` tables from "Модель данных"; the `versions`/`entity_changes`/`drafts` tables and `internal/pgstore` are a later plan).

## Global Constraints

- Go 1.23 (module `github.com/kudes1/firenet`), no cgo (pgx v5 is pure Go — keep `CGO_ENABLED=0` builds working).
- Follow existing project conventions: `writeJSON`/`writeError` response envelopes (`internal/httpapi/handlers.go`), `gofmt`, no new test framework — plain `testing` package (no testify), JS tests via `node --test` loading source through `vm.runInContext` (see `internal/httpapi/web/dirty_guard.test.js`).
- No backward-compat shims: `NewServer`'s signature changes; every call site is updated in the same task, not left dual-mode.
- Every step must actually run and pass before moving to the next; commit after each task.

## Prerequisite: local test database

Several tasks below need a real Postgres to run their tests against (`internal/db`, `internal/auth`, and the `internal/httpapi` tests that now require a login). Start one once, before Task 2:

```bash
docker run --rm -d --name firenet-test-db \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=firenet_test \
  -p 5433:5432 postgres:16-alpine
export FIRENET_TEST_DATABASE_URL="postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable"
```

Tests that need Postgres call `dbtest.Open(t)` (built in Task 2), which calls `t.Skip` if `FIRENET_TEST_DATABASE_URL` isn't set — so `go test ./...` still passes with no DB running, just with less coverage. Export the variable in every shell you run tests from for this plan.

---

### Task 1: Add Postgres and bcrypt dependencies

**Files:**
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Produces: `github.com/jackc/pgx/v5/pgxpool` and `golang.org/x/crypto/bcrypt` importable from any package.

- [ ] **Step 1: Fetch the dependencies**

Run:
```bash
go get github.com/jackc/pgx/v5@latest
go get golang.org/x/crypto@latest
go mod tidy
```

- [ ] **Step 2: Verify the module builds**

Run: `go build ./...`
Expected: succeeds with no source changes yet (only `go.mod`/`go.sum` touched).

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add pgx and bcrypt dependencies"
```

---

### Task 2: `internal/db` — connection pool and migration runner

**Files:**
- Create: `internal/db/migrations/0001_users_sessions.sql`
- Create: `internal/db/db.go`
- Create: `internal/db/dbtest/dbtest.go`
- Create: `internal/db/db_test.go`

**Interfaces:**
- Produces:
  - `db.Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error)`
  - `db.Migrate(ctx context.Context, pool *pgxpool.Pool) error`
  - `dbtest.Open(t *testing.T) *pgxpool.Pool` — skips the test if `FIRENET_TEST_DATABASE_URL` is unset; returns a migrated pool, truncates `users`/`sessions` via `t.Cleanup`.

- [ ] **Step 1: Write the migration**

`internal/db/migrations/0001_users_sessions.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
```

- [ ] **Step 2: Write `internal/db/db.go`**

```go
// Package db owns the Postgres connection pool and the embedded SQL
// migration runner shared by internal/auth and (later) internal/pgstore.
package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open connects to Postgres and verifies the connection with a ping.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect to postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

// Migrate applies every migration under migrations/ not yet recorded in
// schema_migrations, in filename order, each in its own transaction. Safe
// to call on every startup: already-applied migrations are skipped.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		name       TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		var applied bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = $1)`, name).Scan(&applied)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if applied {
			continue
		}

		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}
```

- [ ] **Step 3: Write `internal/db/dbtest/dbtest.go`**

```go
// Package dbtest gives tests a migrated Postgres connection, skipping
// gracefully when no test database is configured.
package dbtest

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kudes1/firenet/internal/db"
)

// Open returns a migrated pool for the calling test, backed by
// FIRENET_TEST_DATABASE_URL. If that env var is unset, the test is
// skipped. Tables that hold per-test data are truncated via t.Cleanup;
// schema_migrations is left alone so Migrate stays a cheap no-op across
// tests. Later plans extend the truncate list as they add tables.
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("FIRENET_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("FIRENET_TEST_DATABASE_URL not set; skipping Postgres-backed test")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("migrate test database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "TRUNCATE users, sessions RESTART IDENTITY CASCADE")
		pool.Close()
	})
	return pool
}
```

- [ ] **Step 4: Write the failing test**

`internal/db/db_test.go`:
```go
package db_test

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestMigrateCreatesUsersAndSessions(t *testing.T) {
	pool := dbtest.Open(t)

	var tableCount int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN ('users', 'sessions')`).Scan(&tableCount)
	if err != nil {
		t.Fatalf("query tables: %v", err)
	}
	if tableCount != 2 {
		t.Fatalf("got %d of the expected tables, want 2", tableCount)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	pool := dbtest.Open(t)

	if err := db.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("second Migrate call failed: %v", err)
	}
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `go test ./internal/db/...`
Expected: FAIL — `dbtest` package doesn't exist yet if steps were applied out of order; if steps 2-3 were already written, this instead exercises the real thing. Since steps 2-3 are written before this test in this task, run it now purely to confirm it PASSES (there is no meaningful red phase here — `db.go`/`dbtest.go` are infrastructure the test can't meaningfully target before they exist). If `FIRENET_TEST_DATABASE_URL` is unset, expected output is `SKIP`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `FIRENET_TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/firenet_test?sslmode=disable go test ./internal/db/... -v`
Expected: `PASS` for both tests (or `SKIP` if the env var isn't exported in this shell — export it per the Prerequisite section and re-run).

- [ ] **Step 7: Commit**

```bash
git add internal/db
git commit -m "feat(db): add Postgres pool and embedded migration runner"
```

---

### Task 3: `internal/auth` — types and password hashing

**Files:**
- Create: `internal/auth/user.go`
- Create: `internal/auth/password.go`
- Create: `internal/auth/password_test.go`

**Interfaces:**
- Produces:
  - `type auth.Role string` with `auth.RoleAdmin`, `auth.RoleUser`
  - `type auth.User struct { ID, Username, PasswordHash string; Role Role; CreatedAt time.Time }`
  - `type auth.Session struct { Token, UserID string; ExpiresAt time.Time }`
  - `auth.HashPassword(plain string) (string, error)`
  - `auth.VerifyPassword(hash, plain string) bool`

- [ ] **Step 1: Write `internal/auth/user.go`**

```go
// Package auth owns users, sessions, password hashing and the HTTP
// middleware that gates firenet's API behind a login.
package auth

import "time"

// Role is a user's access level. RoleAdmin can manage users and (in a
// later plan) confirm/restore project versions; RoleUser can read
// everything and edit their own drafts.
type Role string

const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
)

// User is an account that can log in to firenet.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	Role         Role
	CreatedAt    time.Time
}

// Session is an active login, identified by an opaque bearer token stored
// in an httpOnly cookie.
type Session struct {
	Token     string
	UserID    string
	ExpiresAt time.Time
}
```

- [ ] **Step 2: Write the failing test**

`internal/auth/password_test.go`:
```go
package auth

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "" || hash == "correct horse battery staple" {
		t.Fatalf("HashPassword returned a suspicious hash: %q", hash)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Fatal("VerifyPassword rejected the correct password")
	}
	if VerifyPassword(hash, "wrong password") {
		t.Fatal("VerifyPassword accepted the wrong password")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/auth/...`
Expected: FAIL with `undefined: HashPassword` (build failure).

- [ ] **Step 4: Write `internal/auth/password.go`**

```go
package auth

import (
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// HashPassword returns a bcrypt hash suitable for storing in
// users.password_hash.
func HashPassword(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword reports whether plain matches a hash produced by
// HashPassword.
func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/auth/... -v`
Expected: `PASS`

- [ ] **Step 6: Commit**

```bash
git add internal/auth
git commit -m "feat(auth): add User/Role/Session types and bcrypt password hashing"
```

---

### Task 4: `internal/auth` — user store (CRUD + bootstrap)

**Files:**
- Create: `internal/auth/store.go`
- Create: `internal/auth/store_test.go`

**Interfaces:**
- Consumes: `auth.User`, `auth.Role`, `auth.HashPassword`, `auth.VerifyPassword` (Task 3); `*pgxpool.Pool` (Task 2).
- Produces:
  - `auth.NewStore(pool *pgxpool.Pool) *Store`
  - `(*Store) CreateUser(ctx, username, password string, role Role) (User, error)`
  - `(*Store) GetUserByUsername(ctx, username string) (User, error)`
  - `(*Store) ListUsers(ctx) ([]User, error)`
  - `(*Store) DeleteUser(ctx, id string) error`
  - `(*Store) BootstrapAdmin(ctx, username, password string) error`
  - `(*Store) Authenticate(ctx, username, password string) (User, error)`
  - Sentinel errors: `ErrUserNotFound`, `ErrUsernameTaken`, `ErrInvalidCredentials`, `ErrLastAdmin`

- [ ] **Step 1: Write the failing test**

`internal/auth/store_test.go`:
```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/auth/...`
Expected: FAIL with `undefined: NewStore`.

- [ ] **Step 3: Write `internal/auth/store.go`**

```go
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrUserNotFound       = errors.New("user not found")
	ErrUsernameTaken      = errors.New("username already taken")
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrLastAdmin          = errors.New("cannot remove the last admin")
)

// Store is the Postgres-backed home for users and sessions.
type Store struct {
	db *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{db: pool}
}

func (s *Store) CreateUser(ctx context.Context, username, password string, role Role) (User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}

	var u User
	var roleStr string
	err = s.db.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role)
		VALUES ($1, $2, $3)
		RETURNING id, username, password_hash, role, created_at`,
		username, hash, string(role),
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, ErrUsernameTaken
		}
		return User{}, fmt.Errorf("create user: %w", err)
	}
	u.Role = Role(roleStr)
	return u, nil
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var u User
	var roleStr string
	err := s.db.QueryRow(ctx, `
		SELECT id, username, password_hash, role, created_at FROM users WHERE username = $1`,
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user by username: %w", err)
	}
	u.Role = Role(roleStr)
	return u, nil
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.Query(ctx, `SELECT id, username, password_hash, role, created_at FROM users ORDER BY username`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		var roleStr string
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		u.Role = Role(roleStr)
		users = append(users, u)
	}
	return users, rows.Err()
}

// DeleteUser removes a user, refusing to remove the last remaining admin
// so the team can never lock itself out of user management.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var roleStr string
	err = tx.QueryRow(ctx, `SELECT role FROM users WHERE id = $1 FOR UPDATE`, id).Scan(&roleStr)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return fmt.Errorf("lookup user: %w", err)
	}

	if Role(roleStr) == RoleAdmin {
		var admins int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'admin'`).Scan(&admins); err != nil {
			return fmt.Errorf("count admins: %w", err)
		}
		if admins <= 1 {
			return ErrLastAdmin
		}
	}

	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return tx.Commit(ctx)
}

// BootstrapAdmin creates the first admin account from username/password
// if the users table is empty; it is a no-op once any user exists, so
// it's safe to call on every server startup.
func (s *Store) BootstrapAdmin(ctx context.Context, username, password string) error {
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if count > 0 {
		return nil
	}
	if username == "" || password == "" {
		return errors.New("FIRENET_ADMIN_USER and FIRENET_ADMIN_PASSWORD must be set for the first run")
	}
	_, err := s.CreateUser(ctx, username, password, RoleAdmin)
	return err
}

// Authenticate checks a username/password pair, returning
// ErrInvalidCredentials for either an unknown username or a wrong
// password (never distinguishing the two, to avoid username enumeration).
func (s *Store) Authenticate(ctx context.Context, username, password string) (User, error) {
	u, err := s.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return User{}, ErrInvalidCredentials
		}
		return User{}, err
	}
	if !VerifyPassword(u.PasswordHash, password) {
		return User{}, ErrInvalidCredentials
	}
	return u, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/auth/... -v`
Expected: `PASS` for all tests in the file (or `SKIP` if `FIRENET_TEST_DATABASE_URL` isn't exported in this shell).

- [ ] **Step 5: Commit**

```bash
git add internal/auth/store.go internal/auth/store_test.go
git commit -m "feat(auth): add Postgres-backed user store with admin bootstrap"
```

---

### Task 5: `internal/auth` — sessions

**Files:**
- Create: `internal/auth/session.go`
- Create: `internal/auth/session_test.go`

**Interfaces:**
- Consumes: `*Store` (Task 4).
- Produces:
  - `(*Store) CreateSession(ctx, userID string) (Session, error)`
  - `(*Store) GetSession(ctx, token string) (User, error)`
  - `(*Store) DeleteSession(ctx, token string) error`
  - `ErrSessionNotFound`
  - `const SessionTTL = 7 * 24 * time.Hour`

- [ ] **Step 1: Write the failing test**

`internal/auth/session_test.go`:
```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/auth/...`
Expected: FAIL with `undefined: (*Store).CreateSession`.

- [ ] **Step 3: Write `internal/auth/session.go`**

```go
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrSessionNotFound = errors.New("session not found or expired")

// SessionTTL is how long a login stays valid without being renewed.
const SessionTTL = 7 * 24 * time.Hour

func (s *Store) CreateSession(ctx context.Context, userID string) (Session, error) {
	token, err := newSessionToken()
	if err != nil {
		return Session{}, err
	}
	sess := Session{Token: token, UserID: userID, ExpiresAt: time.Now().Add(SessionTTL)}
	_, err = s.db.Exec(ctx, `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
		sess.Token, sess.UserID, sess.ExpiresAt)
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	return sess, nil
}

// GetSession resolves a bearer token to the user it belongs to, deleting
// and rejecting it if it has expired.
func (s *Store) GetSession(ctx context.Context, token string) (User, error) {
	var u User
	var roleStr string
	var expiresAt time.Time
	err := s.db.QueryRow(ctx, `
		SELECT u.id, u.username, u.password_hash, u.role, u.created_at, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token = $1`, token,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrSessionNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get session: %w", err)
	}
	if time.Now().After(expiresAt) {
		_, _ = s.db.Exec(ctx, `DELETE FROM sessions WHERE token = $1`, token)
		return User{}, ErrSessionNotFound
	}
	u.Role = Role(roleStr)
	return u, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE token = $1`, token); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

func newSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	return hex.EncodeToString(b), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/auth/... -v`
Expected: `PASS` for every test added so far.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/session.go internal/auth/session_test.go
git commit -m "feat(auth): add session issuance, lookup and expiry"
```

---

### Task 6: `internal/auth` — HTTP middleware and cookies

**Files:**
- Create: `internal/auth/middleware.go`
- Create: `internal/auth/middleware_test.go`

**Interfaces:**
- Consumes: `*Store`, `User`, `Role` (Tasks 3-5).
- Produces:
  - `const SessionCookieName = "firenet_session"`
  - `auth.SetSessionCookie(w http.ResponseWriter, token string, expiresAt time.Time)`
  - `auth.ClearSessionCookie(w http.ResponseWriter)`
  - `auth.UserFromContext(ctx context.Context) (User, bool)`
  - `auth.RequireAuth(store *Store) func(http.Handler) http.Handler`
  - `auth.RequireAdmin(next http.Handler) http.Handler`

- [ ] **Step 1: Write the failing test**

`internal/auth/middleware_test.go`:
```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/auth/...`
Expected: FAIL with `undefined: RequireAuth`.

- [ ] **Step 3: Write `internal/auth/middleware.go`**

```go
package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// SessionCookieName is the httpOnly cookie carrying the session token.
const SessionCookieName = "firenet_session"

func SetSessionCookie(w http.ResponseWriter, token string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

type ctxKey struct{}

// UserFromContext returns the user attached by RequireAuth, if any.
func UserFromContext(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(ctxKey{}).(User)
	return u, ok
}

// RequireAuth builds middleware that resolves the session cookie via
// store and rejects the request with 401 if it's missing or invalid.
func RequireAuth(store *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(SessionCookieName)
			if err != nil {
				writeAuthError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			user, err := store.GetSession(r.Context(), cookie.Value)
			if err != nil {
				writeAuthError(w, http.StatusUnauthorized, "authentication required")
				return
			}
			ctx := context.WithValue(r.Context(), ctxKey{}, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireAdmin rejects the request with 403 unless RequireAuth has
// already attached a user with the admin role. Mount it inside
// RequireAuth, never standalone.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := UserFromContext(r.Context())
		if !ok || user.Role != RoleAdmin {
			writeAuthError(w, http.StatusForbidden, "admin role required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/auth/... -v`
Expected: `PASS` for all `internal/auth` tests.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/middleware.go internal/auth/middleware_test.go
git commit -m "feat(auth): add RequireAuth/RequireAdmin middleware and session cookies"
```

---

### Task 7: Wire auth into `internal/httpapi` (login/logout/me, protected routing)

**Files:**
- Create: `internal/httpapi/auth_handlers.go`
- Create: `internal/httpapi/auth_handlers_test.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/handlers_test.go:49-68` (`newTestServer`)

**Interfaces:**
- Consumes: `auth.Store`, `auth.RequireAuth`, `auth.SetSessionCookie`, `auth.ClearSessionCookie`, `auth.SessionCookieName`, `auth.UserFromContext` (Tasks 4-6).
- Produces:
  - `httpapi.NewServer(store ProjectStore, users *auth.Store, log *slog.Logger) http.Handler` (signature change — every call site updated in this task).
  - `POST /api/login`, `POST /api/logout`, `GET /api/me` (unauthenticated login; the other two require a session).
  - All other existing `/api/*` routes now require a valid session (unchanged behavior otherwise).

- [ ] **Step 1: Update `internal/httpapi/server.go`**

Replace the body of `NewServer` (`internal/httpapi/server.go:18-59`) so existing routes move onto a sub-mux gated by `auth.RequireAuth`, and login/logout stay public:

```go
func NewServer(store ProjectStore, users *auth.Store, log *slog.Logger) http.Handler {
	h := &handlers{store: store, users: users, log: log}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/topology", h.getTopology)
	apiMux.HandleFunc("PUT /api/topology", h.putTopology)
	apiMux.HandleFunc("GET /api/subnets", h.getSubnets)
	apiMux.HandleFunc("GET /api/link-exports", h.getLinkExports)
	apiMux.HandleFunc("PUT /api/subnets", h.putSubnets)
	apiMux.HandleFunc("GET /api/rules", h.getRules)
	apiMux.HandleFunc("PUT /api/rules", h.putRules)
	apiMux.HandleFunc("POST /api/validate", h.validate)
	apiMux.HandleFunc("POST /api/compile", h.compile)
	apiMux.HandleFunc("POST /api/diagnose", h.diagnose)
	apiMux.HandleFunc("GET /api/lint", h.lint)
	apiMux.HandleFunc("GET /api/layout", h.getLayout)
	apiMux.HandleFunc("PUT /api/layout", h.putLayout)
	apiMux.HandleFunc("GET /api/me", h.me)
	apiMux.Handle("GET /api/users", auth.RequireAdmin(http.HandlerFunc(h.listUsers)))
	apiMux.Handle("POST /api/users", auth.RequireAdmin(http.HandlerFunc(h.createUser)))
	apiMux.Handle("DELETE /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.deleteUser)))

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	mux.HandleFunc("POST /ui/compile", h.uiCompile)

	// Standalone UI pages.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ui/topology", http.StatusFound)
	})
	mux.HandleFunc("GET /login", servePage("login.html"))
	mux.HandleFunc("GET /ui/topology", servePage("topology.html"))
	mux.HandleFunc("GET /ui/subnets", servePage("subnets.html"))
	mux.HandleFunc("GET /ui/networks", servePage("networks.html"))
	mux.HandleFunc("GET /ui/sets", servePage("sets.html"))
	mux.HandleFunc("GET /ui/unions", servePage("unions.html"))
	mux.HandleFunc("GET /ui/links", servePage("links.html"))
	mux.HandleFunc("GET /ui/rules", servePage("rules.html"))
	mux.HandleFunc("GET /ui/compile", servePage("compile.html"))
	mux.HandleFunc("GET /ui/diagnose", servePage("diagnose.html"))
	mux.HandleFunc("GET /ui/users", servePage("users.html"))

	webRoot, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err) // embedded at build time; can't fail at runtime
	}
	mux.Handle("/", noCache(webRoot, http.FileServer(http.FS(webRoot))))

	return withLogging(log, mux)
}
```

`/ui/compile` was previously reachable without a session too (it renders through `h.uiCompile`, mounted before the API gate); leave it as-is — it's a UI-only render helper, not part of the JSON API surface this task locks down, and gating it is out of scope here. `POST /ui/compile` stays public in this task, matching its current behavior.

Add `"github.com/kudes1/firenet/internal/auth"` to the import block (`internal/httpapi/server.go:1-11`).

- [ ] **Step 2: Add the `users` field to `handlers` and wire it into `internal/httpapi/handlers.go`**

`internal/httpapi/handlers.go:23-26`:
```go
type handlers struct {
	store ProjectStore
	users *auth.Store
	log   *slog.Logger
}
```

Add `"github.com/kudes1/firenet/internal/auth"` to that file's import block (`internal/httpapi/handlers.go:3-21`).

- [ ] **Step 3: Write `internal/httpapi/auth_handlers.go`**

```go
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userResponse struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func toUserResponse(u auth.User) userResponse {
	return userResponse{ID: u.ID, Username: u.Username, Role: string(u.Role)}
}

func (h *handlers) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("decode request body: %w", err))
		return
	}

	user, err := h.users.Authenticate(r.Context(), req.Username, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid username or password"))
		return
	}

	sess, err := h.users.CreateSession(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	auth.SetSessionCookie(w, sess.Token, sess.ExpiresAt)
	writeJSON(w, http.StatusOK, toUserResponse(user))
}

func (h *handlers) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.SessionCookieName); err == nil {
		_ = h.users.DeleteSession(r.Context(), cookie.Value)
	}
	auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) me(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	writeJSON(w, http.StatusOK, toUserResponse(user))
}
```

- [ ] **Step 4: Write `internal/httpapi/user_handlers.go`** (empty stubs would break the build now that `server.go` references them — write the real handlers directly, per Task 8's design, but keep this task focused: only what's needed for the server to compile and for login/logout/me to work)

```go
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
)

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

func (h *handlers) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.users.ListUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	resp := make([]userResponse, len(users))
	for i, u := range users {
		resp[i] = toUserResponse(u)
	}
	writeJSON(w, http.StatusOK, resp)
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
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, errors.New("username and password are required"))
		return
	}

	user, err := h.users.CreateUser(r.Context(), req.Username, req.Password, role)
	if err != nil {
		if errors.Is(err, auth.ErrUsernameTaken) {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, toUserResponse(user))
}

func (h *handlers) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
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

(This is the full, real implementation — Task 8 only adds its tests; there's no throwaway stub here to later replace.)

- [ ] **Step 5: Update `newTestServer` so every existing handler test stays authenticated with zero per-test changes**

Replace `internal/httpapi/handlers_test.go:49-68`:
```go
func newTestServer(t *testing.T) (http.Handler, FileProjectStore) {
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
	if err := store.WriteTopology([]byte(fixtureTopology)); err != nil {
		t.Fatalf("seed topology: %v", err)
	}
	if err := store.WriteSubnets([]byte(fixtureSubnets)); err != nil {
		t.Fatalf("seed subnets: %v", err)
	}
	if err := store.WriteRules([]byte(fixtureRules)); err != nil {
		t.Fatalf("seed rules: %v", err)
	}

	srv := NewServer(store, users, discardLogger())
	return authenticatedHandler(t, srv), store
}

// authenticatedHandler logs in once and returns a handler that stamps
// every incoming test request with that session cookie first, so the
// dozens of existing handler tests that build requests directly and call
// srv.ServeHTTP need no changes to stay authenticated.
func authenticatedHandler(t *testing.T, srv http.Handler) http.Handler {
	t.Helper()
	body, err := json.Marshal(loginRequest{Username: "admin", Password: "test-password-1"})
	if err != nil {
		t.Fatalf("marshal login body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test login failed: status %d, body %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("test login did not set a session cookie")
	}
	sessionCookie := cookies[0]

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.AddCookie(sessionCookie)
		srv.ServeHTTP(w, r)
	})
}
```

Add `"context"`, `"github.com/kudes1/firenet/internal/auth"`, and `"github.com/kudes1/firenet/internal/db/dbtest"` to `internal/httpapi/handlers_test.go`'s import block; `"bytes"`, `"encoding/json"`, and `"net/http/httptest"` are already imported there.

- [ ] **Step 6: Write `internal/httpapi/auth_handlers_test.go`**

```go
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
```

- [ ] **Step 7: Run the full package test suite to verify it fails, then passes**

Run: `go test ./internal/httpapi/... -v`
Expected: first FAIL (server.go references `h.me`/`h.listUsers`/etc. and `auth` before those pieces existed — since steps 1-4 land together in this task, run the build first to catch any typo, then the tests). After steps 1-6 are all in place: `PASS` for every test, both the new auth tests and every pre-existing handler test (via `authenticatedHandler`).

- [ ] **Step 8: Update the one remaining `NewServer` call site**

`internal/cli/serve.go:35` currently calls `httpapi.NewServer(store, log)`. Leave this call broken for now — Task 9 rewrites `serve.go` wholesale to build the Postgres pool and `auth.Store` it needs. Confirm the rest of the module still builds:

Run: `go build ./internal/httpapi/... ./internal/auth/... ./internal/db/...`
Expected: succeeds (only `internal/cli` and `cmd/firenet` are currently broken, and Task 9 fixes them next).

- [ ] **Step 9: Commit**

```bash
git add internal/httpapi
git commit -m "feat(httpapi): require login for the API, add login/logout/me"
```

---

### Task 8: Tests for admin-only user management

**Files:**
- Modify: `internal/httpapi/auth_handlers_test.go`

**Interfaces:**
- Consumes: `h.listUsers`, `h.createUser`, `h.deleteUser` (written in Task 7, Step 4).

- [ ] **Step 1: Add the tests**

Append to `internal/httpapi/auth_handlers_test.go`:
```go
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
```

- [ ] **Step 2: Run the tests**

Run: `go test ./internal/httpapi/... -run 'User' -v`
Expected: `PASS` for all five new tests.

- [ ] **Step 3: Commit**

```bash
git add internal/httpapi/auth_handlers_test.go
git commit -m "test(httpapi): cover admin-only user management endpoints"
```

---

### Task 9: Wire Postgres + bootstrap into `firenet serve`

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/cli/serve.go`
- Modify: `README.md` (Конфигурация table)

**Interfaces:**
- Consumes: `db.Open`, `db.Migrate` (Task 2); `auth.NewStore`, `(*auth.Store).BootstrapAdmin` (Task 4); `httpapi.NewServer(store, users, log)` (Task 7).

- [ ] **Step 1: Extend `internal/config/config.go`**

```go
// Package config loads application configuration from environment variables.
package config

import "os"

// Config holds settings shared by every delivery adapter (CLI today, HTTP later).
type Config struct {
	LogLevel      string
	LogFormat     string
	DatabaseURL   string
	AdminUsername string
	AdminPassword string
}

// Load reads configuration from environment variables, falling back to defaults.
func Load() (Config, error) {
	return Config{
		LogLevel:      getEnv("FIRENET_LOG_LEVEL", "info"),
		LogFormat:     getEnv("FIRENET_LOG_FORMAT", "text"),
		DatabaseURL:   getEnv("FIRENET_DATABASE_URL", ""),
		AdminUsername: getEnv("FIRENET_ADMIN_USER", ""),
		AdminPassword: getEnv("FIRENET_ADMIN_PASSWORD", ""),
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

- [ ] **Step 2: Rewrite `internal/cli/serve.go`**

```go
package cli

import (
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/httpapi"
)

func newServeCmd() *cobra.Command {
	var topologyPath, subnetsPath, rulesPath, addr string
	var openBrowser bool

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve a local web UI for building topology, editing rules and compiling",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			log := loggerFromContext(ctx)

			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cfg.DatabaseURL == "" {
				return fmt.Errorf("FIRENET_DATABASE_URL is required")
			}

			pool, err := db.Open(ctx, cfg.DatabaseURL)
			if err != nil {
				return fmt.Errorf("connect to database: %w", err)
			}
			defer pool.Close()
			if err := db.Migrate(ctx, pool); err != nil {
				return fmt.Errorf("apply migrations: %w", err)
			}

			users := auth.NewStore(pool)
			if err := users.BootstrapAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
				return fmt.Errorf("bootstrap admin account: %w", err)
			}

			store := httpapi.FileProjectStore{
				TopologyPath: topologyPath,
				SubnetsPath:  subnetsPath,
				RulesPath:    rulesPath,
				LayoutPath:   filepath.Join(filepath.Dir(topologyPath), ".firenet-layout.json"),
			}
			if err := store.EnsureSeeded(); err != nil {
				return fmt.Errorf("seed project files: %w", err)
			}

			srv := httpapi.NewServer(store, users, log)
			log.Info("serving firenet web UI", "addr", addr, "topology", topologyPath, "subnets", subnetsPath, "rules", rulesPath)

			if openBrowser {
				go openURL("http://" + addr)
			}
			return http.ListenAndServe(addr, srv)
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "topology.yaml", "path to topology YAML file")
	cmd.Flags().StringVar(&subnetsPath, "subnets", "subnets.yaml", "path to subnets YAML file")
	cmd.Flags().StringVar(&rulesPath, "rules", "rules.yaml", "path to rules YAML file")
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address to listen on")
	cmd.Flags().BoolVar(&openBrowser, "open", false, "open the UI in a browser on start")

	return cmd
}

// openURL best-effort launches the OS default browser; failures are silent
// since this is a convenience, not a requirement.
func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
```

- [ ] **Step 3: Update the README configuration table**

In `README.md`'s `## Конфигурация` table, add three rows after the existing `FIRENET_LOG_FORMAT` row:

```markdown
| `FIRENET_DATABASE_URL` | — (обязательна) | строка подключения к Postgres, напр. `postgres://user:pass@host:5432/firenet?sslmode=disable` |
| `FIRENET_ADMIN_USER`   | — | логин первого admin-аккаунта; обязателен при пустой таблице `users` |
| `FIRENET_ADMIN_PASSWORD` | — | пароль первого admin-аккаунта; обязателен при пустой таблице `users` |
```

- [ ] **Step 4: Verify the whole module builds and vets clean**

Run:
```bash
go build ./...
go vet ./...
gofmt -l .
```
Expected: `go build`/`go vet` produce no output (success); `gofmt -l .` prints nothing (no unformatted files). If `gofmt -l .` lists a file, run `gofmt -w <file>` and re-check.

- [ ] **Step 5: Manually verify `serve` starts against the test database**

Run:
```bash
go run ./cmd/firenet serve \
  --topology /tmp/firenet-manual/topology.yaml \
  --subnets /tmp/firenet-manual/subnets.yaml \
  --rules /tmp/firenet-manual/rules.yaml \
  --addr 127.0.0.1:8787
```
with `FIRENET_DATABASE_URL` (pointing at the Task-2 test database), `FIRENET_ADMIN_USER=admin`, `FIRENET_ADMIN_PASSWORD=change-me-1234` exported first, and `mkdir -p /tmp/firenet-manual` beforehand.
Expected: log line `serving firenet web UI ...`, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/topology` returns `401` (no session yet). Stop the server with Ctrl-C afterward.

- [ ] **Step 6: Commit**

```bash
git add internal/config internal/cli README.md
git commit -m "feat(cli): require Postgres and bootstrap the first admin on serve"
```

---

### Task 10: Web — session-aware `Api` helper and sidebar user badge

**Files:**
- Modify: `internal/httpapi/web/common.js`
- Modify: `internal/httpapi/web/style.css`

**Interfaces:**
- Produces (globals inside `common.js`, matching its existing style of top-level `const`/`function` declarations):
  - `function loginRedirectURL(pathname, search)` — pure, used by the 401 handler and reused by `login.js` (Task 11).
  - `Api.get/post/put` now redirect to `/login` on a `401` response instead of throwing.
  - `buildNav` renders a user-name + "Выйти" control, populated from `GET /api/me`.

- [ ] **Step 1: Add the redirect helper and wire it into `Api`**

In `internal/httpapi/web/common.js`, replace the `const Api = { ... }` block (`internal/httpapi/web/common.js:61-85`) with:

```js
// loginRedirectURL builds the /login target for an unauthenticated
// request, preserving where the user was so they land back there after
// logging in. Guards against open redirects: only same-origin, absolute
// paths are honored as the "next" target.
function loginRedirectURL(pathname, search) {
  const target = pathname + search;
  const safe = target.startsWith("/") && !target.startsWith("//");
  return "/login" + (safe ? "?next=" + encodeURIComponent(target) : "");
}

async function redirectToLogin() {
  window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
  return new Promise(() => {}); // navigation is underway; never resolve
}

const Api = {
  async get(path) {
    const res = await fetch(path);
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
};
```

- [ ] **Step 2: Add the "Пользователи" nav entry and its icon**

In `NAV_STANDALONE` (`internal/httpapi/web/common.js:230-232`):
```js
const NAV_STANDALONE = [
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи" },
];
```

In `NAV_ICONS` (`internal/httpapi/web/common.js:235-245`), add one entry:
```js
  users: svgOpen + '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 8a3 3 0 1 1 0 6"/><path d="M21 20c0-2.5-1.6-4.6-4-5.5"/></svg>',
```

- [ ] **Step 3: Render the user badge + logout control in `buildNav`**

In `internal/httpapi/web/common.js`, right after `aside.append(btn);` (the theme-toggle button, `internal/httpapi/web/common.js:354`) and before the `banner` block, insert:

```js
  const userBox = document.createElement("div");
  userBox.className = "user-box";
  const userName = document.createElement("span");
  userName.className = "user-name";
  const logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.className = "logout-btn";
  logoutBtn.textContent = "Выйти";
  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  });
  userBox.append(userName, logoutBtn);
  aside.append(userBox);

  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .then((me) => {
      if (me) userName.textContent = me.username + (me.role === "admin" ? " · admin" : "");
    })
    .catch(() => {});
```

- [ ] **Step 4: Add CSS for the new elements**

Append to `internal/httpapi/web/style.css`:
```css
.user-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}
.user-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85em;
  color: var(--muted);
}
.sidebar.collapsed .user-name {
  display: none;
}
.logout-btn {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}
.logout-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
```

- [ ] **Step 5: Write the test for the pure redirect helper**

Add to `internal/httpapi/web/dirty_guard.test.js`'s neighbor — create `internal/httpapi/web/login_redirect.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCommon() {
  const sandbox = {
    document: { addEventListener() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), sandbox, { filename: "common.js" });
  return vm.runInContext("({ loginRedirectURL })", sandbox);
}

test("loginRedirectURL preserves a same-origin path as next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("/ui/rules", ""), "/login?next=%2Fui%2Frules");
});

test("loginRedirectURL drops a protocol-relative next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("//evil.com", ""), "/login");
});

test("loginRedirectURL includes the query string in next", () => {
  const { loginRedirectURL } = loadCommon();
  assert.equal(loginRedirectURL("/ui/rules", "?chain=fwd"), "/login?next=%2Fui%2Frules%3Fchain%3Dfwd");
});
```

- [ ] **Step 6: Run the JS tests**

Run: `node --test internal/httpapi/web/login_redirect.test.js`
Expected: `pass 3`, `fail 0`.

- [ ] **Step 7: Run the full JS test suite to check nothing else broke**

Run: `node --test 'internal/httpapi/web/'*.test.js`
Expected: all tests pass (the `common.js` changes are additive to `Api`/`buildNav`, so `dirty_guard.test.js` and every page test should be unaffected).

- [ ] **Step 8: Commit**

```bash
git add internal/httpapi/web/common.js internal/httpapi/web/style.css internal/httpapi/web/login_redirect.test.js
git commit -m "feat(web): redirect to /login on 401 and show the logged-in user in the sidebar"
```

---

### Task 11: Web — login page and users admin page

**Files:**
- Create: `internal/httpapi/web/login.html`
- Create: `internal/httpapi/web/login.js`
- Create: `internal/httpapi/web/users.html`
- Create: `internal/httpapi/web/users.js`
- Modify: `internal/httpapi/web/style.css`

**Interfaces:**
- Consumes: `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET/POST /api/users`, `DELETE /api/users/{id}` (Task 7); `loginRedirectURL`-style "next" parsing convention (Task 10, reimplemented standalone here since `login.html` intentionally doesn't load the full `common.js` sidebar).

- [ ] **Step 1: Write `internal/httpapi/web/login.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet — вход</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body class="login-page">
<main class="login-card">
  <h1>firenet</h1>
  <form id="login-form" autocomplete="on">
    <label>Логин
      <input type="text" name="username" autocomplete="username" required autofocus>
    </label>
    <label>Пароль
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Войти</button>
    <p id="login-error" class="login-error" hidden></p>
  </form>
</main>
<script src="/login.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `internal/httpapi/web/login.js`**

```js
"use strict";

// loginRedirectTarget picks where to send the browser after a successful
// login: the "next" query param if it's a same-origin absolute path,
// otherwise the topology page. Guards against open redirects the same
// way common.js's loginRedirectURL does for the outgoing direction.
function loginRedirectTarget(search) {
  const next = new URLSearchParams(search).get("next");
  const safe = next && next.startsWith("/") && !next.startsWith("//");
  return safe ? next : "/ui/topology";
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.theme =
    localStorage.getItem("firenet-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });

    if (!res.ok) {
      errorEl.textContent = "Неверный логин или пароль";
      errorEl.hidden = false;
      return;
    }
    window.location.href = loginRedirectTarget(window.location.search);
  });
});
```

- [ ] **Step 3: Write the test for `loginRedirectTarget`**

`internal/httpapi/web/login.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadLogin() {
  const sandbox = { document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "login.js"), "utf8"), sandbox, { filename: "login.js" });
  return vm.runInContext("({ loginRedirectTarget })", sandbox);
}

test("loginRedirectTarget defaults to topology when next is missing", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget(""), "/ui/topology");
});

test("loginRedirectTarget accepts a same-origin path", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=%2Fui%2Frules"), "/ui/rules");
});

test("loginRedirectTarget rejects a protocol-relative next", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=%2F%2Fevil.com"), "/ui/topology");
});

test("loginRedirectTarget rejects an absolute URL", () => {
  const { loginRedirectTarget } = loadLogin();
  assert.equal(loginRedirectTarget("?next=https%3A%2F%2Fevil.com"), "/ui/topology");
});
```

- [ ] **Step 4: Run the test**

Run: `node --test internal/httpapi/web/login.test.js`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: Write `internal/httpapi/web/users.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet — пользователи</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head>
<body data-nav="users">
<main class="page">
  <h1>Пользователи</h1>
  <p id="access-denied" class="banner error" hidden>Доступ только для администраторов.</p>

  <table id="users-table" class="data-table" hidden>
    <thead><tr><th>Логин</th><th>Роль</th><th></th></tr></thead>
    <tbody></tbody>
  </table>

  <form id="create-user-form">
    <label>Логин <input type="text" name="username" required></label>
    <label>Пароль <input type="password" name="password" required minlength="8"></label>
    <label>Роль
      <select name="role">
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
    </label>
    <button type="submit">Создать</button>
  </form>
</main>
<script src="/alpine.min.js" defer></script>
<script src="/common.js"></script>
<script src="/users.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write `internal/httpapi/web/users.js`**

```js
"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const table = document.getElementById("users-table");
  const tbody = table.querySelector("tbody");
  const denied = document.getElementById("access-denied");
  const form = document.getElementById("create-user-form");

  async function refresh() {
    const res = await fetch("/api/users");
    if (res.status === 403) {
      denied.hidden = false;
      form.hidden = true;
      return;
    }
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    const users = await res.json();
    tbody.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = u.username;
      const role = document.createElement("td");
      role.textContent = u.role;
      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Удалить";
      del.addEventListener("click", async () => {
        const delRes = await fetch("/api/users/" + u.id, { method: "DELETE" });
        if (delRes.ok) refresh();
        else showBanner((await delRes.json()).error || "Не удалось удалить пользователя", "error");
      });
      actions.append(del);
      tr.append(name, role, actions);
      tbody.append(tr);
    });
    table.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
        role: form.role.value,
      }),
    });
    if (!res.ok) {
      showBanner((await res.json()).error || "Не удалось создать пользователя", "error");
      return;
    }
    form.reset();
    refresh();
  });

  refresh();
});
```

- [ ] **Step 7: Add minimal CSS for the login page and the users table**

Append to `internal/httpapi/web/style.css`:
```css
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
}
.login-card {
  width: min(320px, 90vw);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.login-card h1 {
  margin: 0 0 16px;
  font-size: 1.2em;
}
.login-card label {
  display: block;
  margin-bottom: 12px;
  font-size: 0.9em;
}
.login-card input {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.login-card button {
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-fg);
  cursor: pointer;
}
.login-error {
  margin-top: 12px;
  color: #dc2626;
  font-size: 0.85em;
}
.data-table {
  border-collapse: collapse;
  margin-bottom: 24px;
}
.data-table th, .data-table td {
  border-bottom: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
}
```

- [ ] **Step 8: Run the full JS test suite**

Run: `node --test 'internal/httpapi/web/'*.test.js`
Expected: all tests pass, including the new `login.test.js`.

- [ ] **Step 9: Rebuild the Go binary so the new embedded web assets ship**

Run: `go build ./...`
Expected: succeeds (the `web/*.html`/`*.js` additions are picked up automatically by the existing `go:embed` directive in `internal/httpapi/embed.go`).

- [ ] **Step 10: Commit**

```bash
git add internal/httpapi/web/login.html internal/httpapi/web/login.js internal/httpapi/web/login.test.js \
        internal/httpapi/web/users.html internal/httpapi/web/users.js internal/httpapi/web/style.css
git commit -m "feat(web): add login page and admin user-management page"
```

---

### Task 12: Docker deployment (app + Postgres via docker-compose)

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Modify: `README.md` (new "Развёртывание" section)

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/firenet ./cmd/firenet

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/firenet /firenet
EXPOSE 8787
ENTRYPOINT ["/firenet", "serve", "--addr", "0.0.0.0:8787"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
.git
bin/
out/
*.md
docs/
.serena/
.superpowers/
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: firenet
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: firenet
    volumes:
      - firenet-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U firenet -d firenet"]
      interval: 5s
      timeout: 3s
      retries: 10

  app:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      FIRENET_DATABASE_URL: postgres://firenet:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/firenet?sslmode=disable
      FIRENET_ADMIN_USER: ${FIRENET_ADMIN_USER:?set FIRENET_ADMIN_USER in .env}
      FIRENET_ADMIN_PASSWORD: ${FIRENET_ADMIN_PASSWORD:?set FIRENET_ADMIN_PASSWORD in .env}
    ports:
      - "8787:8787"

volumes:
  firenet-db:
```

- [ ] **Step 4: Write `.env.example`**

```
POSTGRES_PASSWORD=change-me
FIRENET_ADMIN_USER=admin
FIRENET_ADMIN_PASSWORD=change-me-too
```

- [ ] **Step 5: Add a "Развёртывание" section to `README.md`**

Insert after the existing `## Конфигурация` section:

```markdown
## Развёртывание (docker-compose)

```sh
cp .env.example .env   # и поменяйте пароли
docker compose up -d --build
```

Поднимает Postgres и firenet рядом, применяет миграции и создаёт первый
admin-аккаунт из `.env` при первом запуске. UI — на `http://localhost:8787`.
```

- [ ] **Step 6: Verify the image builds**

Run: `docker build -t firenet:local .`
Expected: build succeeds (this doesn't require `.env` — it only compiles the binary).

- [ ] **Step 7: Verify the full stack comes up**

Run:
```bash
cp .env.example .env
docker compose up -d --build
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/api/topology
```
Expected: prints `401` (server is up, route is protected, no session yet). Then tear down:
```bash
docker compose down -v
```

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example README.md
git commit -m "feat(deploy): add Dockerfile and docker-compose for app + Postgres"
```

---

## Self-Review Notes

- **Spec coverage:** "Права и ошибки" role table (admin manages users; 401/403 semantics) — Tasks 6-8. `users`/`sessions` schema from "Модель данных" — Task 2. `FIRENET_ADMIN_USER`/`FIRENET_ADMIN_PASSWORD` bootstrap from "Миграция существующих данных" — Task 9. Docker-compose deployment — Task 12. The `versions`/`entity_changes`/`drafts` tables, `internal/pgstore`, and the draft/confirm/conflict UI are explicitly deferred to the next plan (see this plan's **Architecture** note) — not a gap, a scope boundary agreed with the user.
- **Placeholder scan:** no TODO/TBD; every step has runnable commands or complete code, including the trickier `newTestServer` retrofit (Task 7) and the docker-compose bring-up check (Task 12).
- **Type consistency:** `httpapi.NewServer(store ProjectStore, users *auth.Store, log *slog.Logger)` is introduced in Task 7 and used with that exact signature in Task 9's `serve.go` and Task 7/8's test helpers. `userResponse`/`loginRequest`/`createUserRequest` are defined once (Task 7) and reused as-is in Task 8's tests. `auth.Store` method names/signatures introduced in Tasks 4-6 are used unchanged in Task 7's handlers and Task 9's `serve.go`.
