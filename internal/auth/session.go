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
		SELECT u.id, u.username, u.password_hash, u.role, u.created_at, u.activated, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token = $1`, token,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &roleStr, &u.CreatedAt, &u.Activated, &expiresAt)
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
