package pgstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kudes1/firenet/internal/projectdoc"
)

var ErrNoVersions = errors.New("no versions exist yet")

// VersionInfo is one entry in the confirmed history.
type VersionInfo struct {
	ID          int64
	CreatedAt   time.Time
	ConfirmedBy string // user id; empty for the seeded initial import
	DraftID     string // empty when the version didn't come from a draft (initial import, restore)
	Note        string
}

// CurrentVersion returns the id of the latest confirmed version.
func (s *Store) CurrentVersion(ctx context.Context) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `SELECT id FROM versions ORDER BY id DESC LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNoVersions
	}
	if err != nil {
		return 0, fmt.Errorf("current version: %w", err)
	}
	return id, nil
}

// ReadAt reconstructs the full project as of a specific version.
func (s *Store) ReadAt(ctx context.Context, version int64) (projectdoc.ProjectDoc, error) {
	snapshot, err := s.entitySnapshotAt(ctx, version)
	if err != nil {
		return projectdoc.ProjectDoc{}, err
	}
	return fromEntities(snapshot)
}

// History lists the most recent versions, newest first.
func (s *Store) History(ctx context.Context, limit int) ([]VersionInfo, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, created_at, COALESCE(confirmed_by::text, ''), COALESCE(draft_id::text, ''), COALESCE(note, '')
		FROM versions ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list history: %w", err)
	}
	defer rows.Close()

	var out []VersionInfo
	for rows.Next() {
		var v VersionInfo
		if err := rows.Scan(&v.ID, &v.CreatedAt, &v.ConfirmedBy, &v.DraftID, &v.Note); err != nil {
			return nil, fmt.Errorf("scan version: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// DiffVersions reports every entity that differs between two versions
// (in either direction — from can be newer than to).
func (s *Store) DiffVersions(ctx context.Context, from, to int64) ([]EntityDiff, error) {
	before, err := s.entitySnapshotAt(ctx, from)
	if err != nil {
		return nil, err
	}
	after, err := s.entitySnapshotAt(ctx, to)
	if err != nil {
		return nil, err
	}
	return diffSnapshots(before, after), nil
}
