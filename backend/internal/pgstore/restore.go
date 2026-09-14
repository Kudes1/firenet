package pgstore

import (
	"context"
	"fmt"

	"github.com/kudes1/firenet/internal/auth"
)

// Restore creates a new version whose content equals a past version's,
// by diffing the current state against the target and replaying that
// diff as fresh entity_changes rows (never rewriting history).
func (s *Store) Restore(ctx context.Context, toVersion int64, actor auth.User) (int64, error) {
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return 0, err
	}
	if toVersion == current {
		return current, nil
	}

	currentSnap, err := s.entitySnapshotAt(ctx, current)
	if err != nil {
		return 0, err
	}
	target, err := s.entitySnapshotAt(ctx, toVersion)
	if err != nil {
		return 0, err
	}
	diffs := diffSnapshots(currentSnap, target)
	if len(diffs) == 0 {
		return current, nil
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var versionID int64
	note := fmt.Sprintf("restored to v%d", toVersion)
	if err := tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, note) VALUES ($1,$2) RETURNING id`, actor.ID, note).Scan(&versionID); err != nil {
		return 0, fmt.Errorf("insert version: %w", err)
	}
	for _, d := range diffs {
		var data []byte
		if d.Change != "removed" {
			data = d.After
		}
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, d.Kind, d.Key, d.Change, data, actor.ID)
		if err != nil {
			return 0, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	s.invalidateSnapshots()
	return versionID, nil
}
