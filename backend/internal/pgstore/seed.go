package pgstore

import (
	"context"
	"errors"
	"fmt"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/projectdoc"
)

// SeedInitialVersion records doc as version 1 (author-attributed to
// actor, no draft) — used once, at first startup, to import whatever
// legacy topology.yaml/subnets.yaml/rules.yaml/layout the project had
// before this feature existed. A no-op (returns the existing version)
// once any version exists, so it's safe to call on every startup.
func (s *Store) SeedInitialVersion(ctx context.Context, doc projectdoc.ProjectDoc, actor auth.User) (int64, error) {
	existing, err := s.CurrentVersion(ctx)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, ErrNoVersions) {
		return 0, err
	}

	entities, err := toEntities(doc)
	if err != nil {
		return 0, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var versionID int64
	if err := tx.QueryRow(ctx, `INSERT INTO versions (confirmed_by, note) VALUES ($1,'initial import') RETURNING id`, actor.ID).Scan(&versionID); err != nil {
		return 0, fmt.Errorf("insert version: %w", err)
	}
	for ref, data := range entities {
		_, err := tx.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,'added',$4,$5)`,
			versionID, ref.Kind, ref.Key, data, actor.ID)
		if err != nil {
			return 0, fmt.Errorf("insert entity_change: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return versionID, nil
}
