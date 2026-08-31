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
		RETURNING id, username, password_hash, role, created_at, activated`,
		username, hash, string(role),
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
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
		SELECT id, username, password_hash, role, created_at, activated FROM users WHERE username = $1`,
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated)
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
	rows, err := s.db.Query(ctx, `SELECT id, username, password_hash, role, created_at, activated FROM users ORDER BY username`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		var roleStr string
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated); err != nil {
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
