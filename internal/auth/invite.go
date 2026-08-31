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
