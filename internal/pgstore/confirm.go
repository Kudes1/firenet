package pgstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/auth"
)

// ErrConfirmRace means another confirm landed between this Confirm
// call's conflict check and its write transaction; the caller should
// re-check conflicts and retry.
var ErrConfirmRace = errors.New("another confirm landed first; recheck conflicts and retry")

// EntityConflict is one entity a draft touched that also changed,
// independently, since the draft's base version.
type EntityConflict struct {
	Kind         string
	Key          string
	DraftValue   json.RawMessage // nil if the draft removed this entity
	CurrentValue json.RawMessage // nil if the entity doesn't exist in the current version
}

// Conflicts reports entities the draft has touched that also changed,
// independently, between the draft's base version and the current one.
// An entity the draft touched but nobody else changed is not a conflict.
func (s *Store) Conflicts(ctx context.Context, draftID string) ([]EntityConflict, error) {
	d, err := s.GetDraft(ctx, draftID)
	if err != nil {
		return nil, err
	}
	current, err := s.CurrentVersion(ctx)
	if err != nil {
		return nil, err
	}
	if current == d.BaseVersionID {
		return nil, nil // nothing confirmed since the draft was based; nothing to conflict with
	}

	base, err := s.entitySnapshotAt(ctx, d.BaseVersionID)
	if err != nil {
		return nil, err
	}
	currentSnap, err := s.entitySnapshotAt(ctx, current)
	if err != nil {
		return nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return nil, err
	}

	var conflicts []EntityConflict
	for ref, ov := range overrides {
		baseRow, hadBase := base[ref]
		curRow, hasCurrent := currentSnap[ref]
		switch {
		case !hadBase && !hasCurrent:
			// The draft added a brand-new entity nobody else touched.
		case hadBase && hasCurrent && jsonEqual(baseRow.Data, curRow.Data):
			// Untouched upstream since the draft's base.
		default:
			var draftValue json.RawMessage
			if ov.Change != "removed" {
				draftValue = ov.Data
			}
			var currentValue json.RawMessage
			if hasCurrent {
				currentValue = curRow.Data
			}
			conflicts = append(conflicts, EntityConflict{Kind: ref.Kind, Key: ref.Key, DraftValue: draftValue, CurrentValue: currentValue})
		}
	}
	sort.Slice(conflicts, func(i, j int) bool {
		if conflicts[i].Kind != conflicts[j].Kind {
			return conflicts[i].Kind < conflicts[j].Kind
		}
		return conflicts[i].Key < conflicts[j].Key
	})
	return conflicts, nil
}

// Confirm merges a draft into a new version if nothing it touched has
// changed independently since its base version. On conflict, no version
// is created and the draft is marked "conflict"; the caller (an admin)
// gets the conflicting entities back instead of an error.
func (s *Store) Confirm(ctx context.Context, draftID string, admin auth.User) (int64, []EntityConflict, error) {
	conflicts, err := s.Conflicts(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	if len(conflicts) > 0 {
		if _, err := s.db.Exec(ctx, `UPDATE drafts SET status='conflict', updated_at=now() WHERE id=$1`, draftID); err != nil {
			return 0, nil, fmt.Errorf("mark draft conflicted: %w", err)
		}
		return 0, conflicts, nil
	}

	d, err := s.GetDraft(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		return 0, nil, err
	}
	observedCurrent, err := s.CurrentVersion(ctx)
	if err != nil {
		return 0, nil, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize confirms against each other, and re-verify nothing was
	// confirmed between the conflict check above and this lock.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('firenet_confirm'))`); err != nil {
		return 0, nil, fmt.Errorf("acquire confirm lock: %w", err)
	}
	var nowCurrent int64
	if err := tx.QueryRow(ctx, `SELECT id FROM versions ORDER BY id DESC LIMIT 1`).Scan(&nowCurrent); err != nil {
		return 0, nil, fmt.Errorf("recheck current version: %w", err)
	}
	if nowCurrent != observedCurrent {
		return 0, nil, ErrConfirmRace
	}

	var versionID int64
	err = tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, draft_id) VALUES ($1,$2) RETURNING id`, admin.ID, draftID).Scan(&versionID)
	if err != nil {
		return 0, nil, fmt.Errorf("insert version: %w", err)
	}
	for ref, row := range overrides {
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, ref.Kind, ref.Key, row.Change, row.Data, d.Owner)
		if err != nil {
			return 0, nil, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE drafts SET status='merged', updated_at=now() WHERE id=$1`, draftID); err != nil {
		return 0, nil, fmt.Errorf("mark draft merged: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, fmt.Errorf("commit: %w", err)
	}
	s.invalidateSnapshots()
	return versionID, nil, nil
}
