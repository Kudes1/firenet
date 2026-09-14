package pgstore

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/db/dbtest"
)

func newTestStoreWithUser(t *testing.T) (*Store, auth.User) {
	t.Helper()
	pool := dbtest.Open(t)
	users := auth.NewStore(pool)
	u, err := users.CreateUser(context.Background(), "tester", "hunter22222", auth.RoleAdmin)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return NewStore(pool), u
}

// insertVersion is a raw-SQL test helper. Task 7 (Confirm) and Task 8
// (Restore) are the real way versions get created; entitySnapshotAt needs
// to be tested before either exists.
func insertVersion(t *testing.T, s *Store, author auth.User, entities map[entityRef]entityRow) int64 {
	t.Helper()
	ctx := context.Background()
	var versionID int64
	err := s.db.QueryRow(ctx, `INSERT INTO versions (confirmed_by) VALUES ($1) RETURNING id`, author.ID).Scan(&versionID)
	if err != nil {
		t.Fatalf("insert version: %v", err)
	}
	for ref, row := range entities {
		_, err := s.db.Exec(ctx, `INSERT INTO entity_changes (version_id, kind, key, change, data, author) VALUES ($1,$2,$3,$4,$5,$6)`,
			versionID, ref.Kind, ref.Key, row.Change, row.Data, author.ID)
		if err != nil {
			t.Fatalf("insert entity_change: %v", err)
		}
	}
	return versionID
}

func insertDraft(t *testing.T, s *Store, owner auth.User, baseVersion int64) string {
	t.Helper()
	var id string
	err := s.db.QueryRow(context.Background(), `INSERT INTO drafts (owner, name, base_version_id) VALUES ($1,$2,$3) RETURNING id`,
		owner.ID, "test-draft", baseVersion).Scan(&id)
	if err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	return id
}

func TestEntitySnapshotAtLatestPerKey(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "modified", Data: []byte(`{"name":"r1","kind":"switch"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	atV1, err := s.entitySnapshotAt(ctx, v1)
	if err != nil {
		t.Fatalf("entitySnapshotAt(v1): %v", err)
	}
	if len(atV1) != 1 {
		t.Fatalf("got %d entities at v1, want 1", len(atV1))
	}

	atV2, err := s.entitySnapshotAt(ctx, v2)
	if err != nil {
		t.Fatalf("entitySnapshotAt(v2): %v", err)
	}
	if len(atV2) != 2 {
		t.Fatalf("got %d entities at v2, want 2", len(atV2))
	}
	// Postgres's JSONB re-serializes (key order, whitespace) on the way
	// back out, so compare decoded values rather than raw bytes.
	var gotR1 map[string]string
	if err := json.Unmarshal(atV2[entityRef{Kind: kindDevice, Key: "r1"}].Data, &gotR1); err != nil {
		t.Fatalf("decode r1 at v2: %v", err)
	}
	if gotR1["kind"] != "switch" {
		t.Fatalf("got stale data at v2: %+v", gotR1)
	}
}

func TestEntitySnapshotAtExcludesRemoved(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "removed"},
	})

	snapshot, err := s.entitySnapshotAt(ctx, v2)
	if err != nil {
		t.Fatalf("entitySnapshotAt: %v", err)
	}
	if len(snapshot) != 0 {
		t.Fatalf("got %d entities, want 0 (r1 was removed)", len(snapshot))
	}
}

func TestDraftOverrides(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})
	draftID := insertDraft(t, s, author, v1)

	_, err := s.db.Exec(ctx, `INSERT INTO draft_entity_changes (draft_id, kind, key, change, data) VALUES ($1,$2,$3,$4,$5)`,
		draftID, kindDevice, "r2", "added", []byte(`{"name":"r2"}`))
	if err != nil {
		t.Fatalf("insert draft_entity_change: %v", err)
	}

	overrides, err := s.draftOverrides(ctx, draftID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 1 {
		t.Fatalf("got %d overrides, want 1", len(overrides))
	}
}

func TestMergeSnapshot(t *testing.T) {
	base := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2"}`)},
	}
	overrides := map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r2"}: {Change: "removed"},
		{Kind: kindDevice, Key: "r3"}: {Change: "added", Data: []byte(`{"name":"r3"}`)},
	}

	merged := mergeSnapshot(base, overrides)
	if len(merged) != 2 {
		t.Fatalf("got %d entities, want 2", len(merged))
	}
	if _, ok := merged[entityRef{Kind: kindDevice, Key: "r2"}]; ok {
		t.Fatal("r2 should have been removed by the override")
	}
	if _, ok := merged[entityRef{Kind: kindDevice, Key: "r3"}]; !ok {
		t.Fatal("r3 should have been added by the override")
	}
}
