# Users page redesign: visual restyle + invite-link account activation

## Motivation

`users.html`/`users.js` predate the app's current design system (the
Alpine-based `dialog.modal` / `data-table` pattern already used by
`devices.js`, `networks.js`, `sets.js`, etc.) and look visually
inconsistent with the rest of the app.

Separately, user creation currently requires the admin to type a
plaintext password for the new account (`users.html:22`). This lets an
admin set a weak password the user never changes, and requires the
admin to somehow communicate that password out-of-band. Instead, the
admin should only choose a username and role; the system generates a
temporary invite link (valid 24h) that the admin copies and hands to
the user. Visiting the link lets the user set (and confirm) their own
password. Until then, the account cannot log in.

## Scope

**In scope:**
- Visual restyle of the users page to match the app's design system.
- Replace admin-set-password creation with an invite-link flow.
- Admin can regenerate an invite link for a still-pending user (e.g.
  after the original link expired unused).
- Admin can edit an existing user's **role** (no such capability
  exists today — only list/create/delete).
- A new public (unauthenticated) page where an invited user sets their
  password.

**Out of scope (explicitly not building):**
- Email delivery of the invite link — no email/SMTP infrastructure
  exists in this project; the admin copies the link and shares it
  manually.
- Editing a user's username after creation.
- Self-service "forgot password" flow for already-active users (this
  spec only covers first-activation via invite).

## Data model

Extend `users` (new migration, e.g. `0002_user_invites.sql`):

```sql
ALTER TABLE users
  ADD COLUMN activated       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN invite_token    TEXT,
  ADD COLUMN invite_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_invite_token_idx ON users (invite_token)
  WHERE invite_token IS NOT NULL;
```

- Existing rows default to `activated = TRUE` (unaffected).
- A user created via the invite flow starts with `activated = FALSE`,
  `password_hash = ''` (an empty string is never a valid bcrypt hash,
  so `Authenticate` naturally rejects any login attempt for a pending
  account — no separate `activated` check is needed in the login
  path), a fresh `invite_token`, and `invite_expires_at = now() + 24h`.
- Activating the account (setting a password) clears `invite_token`
  and `invite_expires_at` and flips `activated = TRUE`.
- One invite per user: creating a new invite (initial create, or
  regenerate) simply overwrites the existing token/expiry columns —
  no separate `invites` table, no history of past tokens.

## Backend changes

### `internal/auth` (store)

New methods on `Store`, modeled on the existing session-token
machinery (`internal/auth/session.go`):

- `CreateUserInvite(ctx, username string, role Role) (User, token string, error)`
  — inserts the user row as described above, returns the plaintext
  token (only ever returned once, never re-readable). Reuses
  `ErrUsernameTaken` for a collision.
- `RegenerateInvite(ctx, id string) (token string, error)` — new
  `ErrAlreadyActivated` if the target user's `activated` is already
  `TRUE`; otherwise overwrites token/expiry and returns the new token.
- `GetUserByInviteToken(ctx, token string) (User, error)` — new
  `ErrInviteExpired` if `invite_expires_at` has passed (mirrors the
  lazy-expiry read pattern in `GetSession`), `ErrUserNotFound` if the
  token doesn't match any row.
- `ActivateUser(ctx, token, password string) (User, error)` — re-reads
  and validates the token same as `GetUserByInviteToken`, hashes
  `password` via the existing `HashPassword`, sets `password_hash`,
  `activated = TRUE`, clears the invite columns.
- `UpdateUserRole(ctx, id string, role Role) error` — analogous to the
  role-check in `DeleteUser`: reuses `ErrLastAdmin` if this would leave
  zero admins (demoting the last admin).

Token generation reuses the same approach as `newSessionToken()`
(`crypto/rand`, 32 bytes, hex-encoded).

### `internal/httpapi` (handlers)

- `userResponse` / `toUserResponse` (`auth_handlers.go:17-25`) gain two
  fields the redesigned table needs to render: `activated bool` and
  `createdAt string` (RFC3339, from `User.CreatedAt`). Every existing
  caller of `toUserResponse` (list/create/me) picks these up for free.
- `createUser` (`user_handlers.go:31`): request body drops `password`,
  becomes `{username, role}`. Calls `CreateUserInvite`. Response
  becomes `{user: userResponse, inviteUrl: string}` — the URL is built
  as `<scheme>://<host>/invite/<token>` from the request.
- New `updateUser` — `PATCH /api/users/{id}`, admin-only, body
  `{role}`. Refuses (400) if `id` is the caller's own id (an admin
  can't change their own role — prevents accidental self-lockout,
  mirrors the spirit of the existing `ErrLastAdmin` guard on delete).
- New `regenerateInvite` — `POST /api/users/{id}/invite`, admin-only,
  no body. Returns `{inviteUrl}`. Maps `ErrAlreadyActivated` → 400.
- `deleteUser` (`user_handlers.go:59`): add the same self-delete guard
  as `updateUser` (400 if `id` is the caller's own id) — the existing
  `ErrLastAdmin` check only stops the *last* admin from deleting
  themselves; this closes the gap for admins who aren't the last one.
- New file `invite_handlers.go`, both routes **public** (registered on
  `mux`, not `apiMux`, alongside `/api/login`):
  - `GET /api/invites/{token}` → `{username}` on success; 404 if
    unknown, 410 Gone if expired.
  - `POST /api/invites/{token}` → body `{password, confirmPassword}`;
    validates match and the same `minlength 8` rule the old form used;
    calls `ActivateUser`; 200 with no body (or `{ok:true}`) on success,
    same 404/410 mapping as GET, 400 for validation failures.

### Routing (`server.go`)

```go
apiMux.Handle("PATCH /api/users/{id}", auth.RequireAdmin(http.HandlerFunc(h.updateUser)))
apiMux.Handle("POST /api/users/{id}/invite", auth.RequireAdmin(http.HandlerFunc(h.regenerateInvite)))

mux.HandleFunc("GET /api/invites/{token}", h.getInvite)
mux.HandleFunc("POST /api/invites/{token}", h.acceptInvite)
mux.HandleFunc("GET /invite/{token}", servePage("invite.html"))
```

`GET /invite/{token}` is registered next to `GET /login` — outside any
auth gate, since the whole point is that the visitor isn't logged in
yet.

## Frontend changes

### `users.html` / `users.js` (full rewrite, matching `devices.js`)

- `data-nav="users"`, `x-data="appData()"`, `@notify.window=...` shell
  like `devices.html:15`.
- `.table-toolbar` header + `dialog.modal`-based editing, `data-table`
  with resizable columns (`columns.js`), same as `devices.js`.
- Columns: Логин | Роль | Статус | Создан | (actions).
  - Статус renders the existing `.badge` component
    (`style.css:1059`): `badge-ok` "Активен" when `activated`,
    `badge-warn` "Ожидает" otherwise — no new CSS needed.
- Row actions (`icon-btn`, same SVGs as `devices.html:60-61`):
  - **Edit** (role) — all rows, opens a modal with just a role
    `<select>` and Save/Cancel, same shape as `devices.js`'s
    `openEdit`/`saveDraft`.
  - **Ссылка** (link icon) — pending rows only, calls
    `POST /api/users/{id}/invite`.
  - **Delete** — all rows except the row for the logged-in user
    (compare against `Api.get(apiPath("me"))`'s id, hide/disable that
    row's delete button client-side; the server-side guard above is
    the real enforcement).
- "Add user" button in `.toolbar-actions` opens a create modal:
  Логин + Роль only (no password field). On success, close it and open
  a second small modal — reused for both create and regenerate —
  showing the returned `inviteUrl` in a readonly input with a "Copy"
  button (`navigator.clipboard.writeText`) and the note "Ссылка
  действительна 24 часа и показывается только один раз."

### New `invite.html` / `invite.js` (modeled on `login.html`/`login.js`)

- Same standalone shell as `login.html` (no sidebar, no `common.js`
  nav wiring, manual `data-theme` bootstrap like `login.js:14-16`),
  `.login-card` styling reused as-is.
- On load: `GET /api/invites/{token}`.
  - Success → show "Здравствуйте, {username}, задайте пароль" with
    password + confirm-password fields (client-side match + `minlength
    8` check, mirroring the old form's validation) and a submit
    button.
  - 404/410 → replace the form with a plain message: "Ссылка
    недействительна или истекла. Обратитесь к администратору за новой
    ссылкой."
- On submit: `POST /api/invites/{token}`. Success → redirect to
  `/login?activated=1` (the query param lets `login.js` show a small
  one-time success banner, following the same "next"-param pattern
  `login.js:7-11` already uses for redirects).

## Error handling summary

| Case | Response |
|---|---|
| Invite token unknown | 404 |
| Invite token expired | 410 |
| Password/confirm mismatch or too short | 400, inline field error |
| Regenerate invite for an already-activated user | 400 |
| Admin edits/deletes their own account | 400 |
| Role update would remove the last admin | 400 (`ErrLastAdmin`, existing pattern) |
| Username taken on create | 409 (existing pattern, unchanged) |

## Testing

Automated only, per project convention (no manual browser pass):

- Go: unit tests for the new/changed `auth.Store` methods
  (`CreateUserInvite`, `RegenerateInvite`, `GetUserByInviteToken`
  expiry handling, `ActivateUser`, `UpdateUserRole`) and handler-level
  tests for `createUser` (no password field), `updateUser`,
  `regenerateInvite`, `getInvite`/`acceptInvite` (including expired
  and self-guard cases).
- JS: `users_page.test.js` and `invite_page.test.js`, following the
  existing pattern in `devices_page.test.js` / `networks_page.test.js`.

## Non-goals / open follow-ups (not part of this change)

- Email delivery of invite links.
- Editing a user's username.
- A general "reset password" flow for active accounts.
