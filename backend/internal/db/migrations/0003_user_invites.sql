ALTER TABLE users
  ADD COLUMN activated         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN invite_token      TEXT,
  ADD COLUMN invite_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_invite_token_idx ON users (invite_token)
  WHERE invite_token IS NOT NULL;
