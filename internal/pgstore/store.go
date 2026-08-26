package pgstore

import (
	"context"
	"fmt"
	"maps"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the Postgres-backed home for a project's version history and
// personal drafts.
type Store struct {
	db *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{db: pool}
}

// entitySnapshotAt returns the live entity set as of versionID: for each
// (kind, key), the row with the highest version_id <= versionID, unless
// that row's change is "removed".
func (s *Store) entitySnapshotAt(ctx context.Context, versionID int64) (map[entityRef]entityRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT kind, key, change, data FROM (
			SELECT DISTINCT ON (kind, key) kind, key, change, data
			FROM entity_changes
			WHERE version_id <= $1
			ORDER BY kind, key, version_id DESC
		) latest
		WHERE change != 'removed'`, versionID)
	if err != nil {
		return nil, fmt.Errorf("query entity snapshot at %d: %w", versionID, err)
	}
	defer rows.Close()

	out := map[entityRef]entityRow{}
	for rows.Next() {
		var ref entityRef
		var row entityRow
		if err := rows.Scan(&ref.Kind, &ref.Key, &row.Change, &row.Data); err != nil {
			return nil, fmt.Errorf("scan entity snapshot row: %w", err)
		}
		out[ref] = row
	}
	return out, rows.Err()
}

// draftOverrides returns a draft's current per-entity edits, including
// "removed" tombstones — mergeSnapshot needs those to delete the
// corresponding key from the base snapshot.
func (s *Store) draftOverrides(ctx context.Context, draftID string) (map[entityRef]entityRow, error) {
	rows, err := s.db.Query(ctx, `SELECT kind, key, change, data FROM draft_entity_changes WHERE draft_id = $1`, draftID)
	if err != nil {
		return nil, fmt.Errorf("query draft overrides: %w", err)
	}
	defer rows.Close()

	out := map[entityRef]entityRow{}
	for rows.Next() {
		var ref entityRef
		var row entityRow
		if err := rows.Scan(&ref.Kind, &ref.Key, &row.Change, &row.Data); err != nil {
			return nil, fmt.Errorf("scan draft override row: %w", err)
		}
		out[ref] = row
	}
	return out, rows.Err()
}

// mergeSnapshot applies overrides onto base: a "removed" override deletes
// the key; anything else replaces it.
func mergeSnapshot(base, overrides map[entityRef]entityRow) map[entityRef]entityRow {
	out := make(map[entityRef]entityRow, len(base)+len(overrides))
	maps.Copy(out, base)
	for k, v := range overrides {
		if v.Change == "removed" {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}
