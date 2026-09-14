package pgstore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/projectdoc"
)

var (
	ErrDraftNotFound    = errors.New("draft not found")
	ErrDraftNameTaken   = errors.New("a draft with this name already exists")
	ErrRevisionMismatch = errors.New("draft was changed by another request; reload and retry")
)

// Draft is a personal set of edits layered on top of a base version.
type Draft struct {
	ID            string
	Owner         string
	Name          string
	BaseVersionID int64
	Status        string // open|conflict|merged|closed
	Revision      int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

const draftColumns = "id, owner::text, name, base_version_id, status, revision, created_at, updated_at"

func scanDraft(row pgx.Row) (Draft, error) {
	var d Draft
	err := row.Scan(&d.ID, &d.Owner, &d.Name, &d.BaseVersionID, &d.Status, &d.Revision, &d.CreatedAt, &d.UpdatedAt)
	return d, err
}

// CreateDraft opens a new personal draft from the current version.
func (s *Store) CreateDraft(ctx context.Context, owner auth.User, name string) (Draft, error) {
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return Draft{}, err
	}
	d, err := scanDraft(s.db.QueryRow(ctx, `
		INSERT INTO drafts (owner, name, base_version_id)
		VALUES ($1, $2, $3)
		RETURNING `+draftColumns, owner.ID, name, current))
	if err != nil {
		if isUniqueViolation(err) {
			return Draft{}, ErrDraftNameTaken
		}
		return Draft{}, fmt.Errorf("create draft: %w", err)
	}
	return d, nil
}

// ListDrafts lists drafts, optionally filtered to one owner (pass nil for
// every draft — used for admin review).
func (s *Store) ListDrafts(ctx context.Context, owner *auth.User) ([]Draft, error) {
	var rows pgx.Rows
	var err error
	if owner != nil {
		rows, err = s.db.Query(ctx, `SELECT `+draftColumns+` FROM drafts WHERE owner = $1 ORDER BY created_at DESC`, owner.ID)
	} else {
		rows, err = s.db.Query(ctx, `SELECT `+draftColumns+` FROM drafts ORDER BY created_at DESC`)
	}
	if err != nil {
		return nil, fmt.Errorf("list drafts: %w", err)
	}
	defer rows.Close()

	var out []Draft
	for rows.Next() {
		d, err := scanDraft(rows)
		if err != nil {
			return nil, fmt.Errorf("scan draft: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetDraft returns a draft's metadata (owner, status, base version,
// revision) without resolving its document — used by internal/httpapi
// for ownership checks before a full ReadDraft/WriteDraft.
func (s *Store) GetDraft(ctx context.Context, draftID string) (Draft, error) {
	d, err := scanDraft(s.db.QueryRow(ctx, `SELECT `+draftColumns+` FROM drafts WHERE id = $1`, draftID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Draft{}, ErrDraftNotFound
	}
	if err != nil {
		return Draft{}, fmt.Errorf("get draft: %w", err)
	}
	return d, nil
}

func revisionToken(rev int64) string { return strconv.FormatInt(rev, 10) }

// ReadDraft returns the draft's current effective document (its base
// version with its own edits layered on top) and a CAS token for
// WriteDraft.
func (s *Store) ReadDraft(ctx context.Context, draftID string) (projectdoc.ProjectDoc, string, error) {
	d, err := s.GetDraft(ctx, draftID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	doc, err := fromEntities(mergeSnapshot(base, overrides))
	if err != nil {
		return projectdoc.ProjectDoc{}, "", err
	}
	return doc, revisionToken(d.Revision), nil
}

// WriteDraft replaces the draft's edits with whatever doc implies
// relative to its base version: entities that now differ from base are
// upserted into draft_entity_changes; entities that used to differ but
// now match base again are cleared, so a draft only ever stores real
// diffs. CAS via expectRevision, from a prior ReadDraft/WriteDraft call.
func (s *Store) WriteDraft(ctx context.Context, draftID string, doc projectdoc.ProjectDoc, expectRevision string) (string, error) {
	d, err := s.GetDraft(ctx, draftID)
	if err != nil {
		return "", err
	}
	if revisionToken(d.Revision) != expectRevision {
		return "", ErrRevisionMismatch
	}

	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return "", err
	}
	targetEntities, err := toEntities(doc)
	if err != nil {
		return "", err
	}
	target := make(map[entityRef]entityRow, len(targetEntities))
	for ref, data := range targetEntities {
		target[ref] = entityRow{Data: data}
	}
	diffs := diffSnapshots(base, target)

	existingOverrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return "", err
	}
	touched := make(map[entityRef]bool, len(diffs))
	for _, diff := range diffs {
		touched[entityRef{Kind: diff.Kind, Key: diff.Key}] = true
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for ref := range existingOverrides {
		if touched[ref] {
			continue
		}
		if _, err := tx.Exec(ctx, `DELETE FROM draft_entity_changes WHERE draft_id=$1 AND kind=$2 AND key=$3`, draftID, ref.Kind, ref.Key); err != nil {
			return "", fmt.Errorf("clear stale draft override: %w", err)
		}
	}
	for _, diff := range diffs {
		var data []byte
		if diff.Change != "removed" {
			data = diff.After
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO draft_entity_changes (draft_id, kind, key, change, data)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (draft_id, kind, key) DO UPDATE SET change = EXCLUDED.change, data = EXCLUDED.data`,
			draftID, diff.Kind, diff.Key, diff.Change, data)
		if err != nil {
			return "", fmt.Errorf("upsert draft override: %w", err)
		}
	}

	newRevision := d.Revision + 1
	tag, err := tx.Exec(ctx, `UPDATE drafts SET revision=$1, updated_at=now() WHERE id=$2 AND revision=$3`, newRevision, draftID, d.Revision)
	if err != nil {
		return "", fmt.Errorf("bump draft revision: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", ErrRevisionMismatch
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return revisionToken(newRevision), nil
}

func (s *Store) DeleteDraft(ctx context.Context, draftID string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM drafts WHERE id=$1`, draftID)
	if err != nil {
		return fmt.Errorf("delete draft: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrDraftNotFound
	}
	return nil
}

// DiffDraft reports every entity the draft has changed relative to its
// base version.
func (s *Store) DiffDraft(ctx context.Context, draftID string) ([]EntityDiff, error) {
	d, err := s.GetDraft(ctx, draftID)
	if err != nil {
		return nil, err
	}
	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return nil, err
	}
	return diffSnapshots(base, mergeSnapshot(base, overrides)), nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
