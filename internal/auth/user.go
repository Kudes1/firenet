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
