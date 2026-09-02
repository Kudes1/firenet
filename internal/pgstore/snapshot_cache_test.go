package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

// The snapshot cache must be transparent: a second ReadAt of the same
// version returns identical data, and after a confirm invalidates the
// cache, ReadAt of the current version must reflect the new state.

func TestSnapshotCacheSeesNewStateAfterConfirm(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	// Warm the cache at v1.
	v1, err := s.CurrentVersion(ctx)
	if err != nil {
		t.Fatalf("CurrentVersion: %v", err)
	}
	before, err := s.ReadAt(ctx, v1)
	if err != nil {
		t.Fatalf("ReadAt(v1): %v", err)
	}
	if len(before.Topology.Devices) != 1 {
		t.Fatalf("got %d devices before confirm, want 1", len(before.Topology.Devices))
	}

	// Add r2 via a draft confirm; invalidation must make the new device
	// visible despite the warmed cache.
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, revision, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}
	doc.Topology.Devices = append(doc.Topology.Devices, projectdoc.DeviceDoc{Name: "r2", Kind: "router"})
	if _, err := s.WriteDraft(ctx, d.ID, doc, revision); err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}
	v2, _, err := s.Confirm(ctx, d.ID, author)
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	after, err := s.ReadAt(ctx, v2)
	if err != nil {
		t.Fatalf("ReadAt(v2): %v", err)
	}
	if len(after.Topology.Devices) != 2 {
		t.Fatalf("got %d devices after confirm, want 2 (stale cache?)", len(after.Topology.Devices))
	}

	// The old version's snapshot is immutable: still exactly one device.
	stillV1, err := s.ReadAt(ctx, v1)
	if err != nil {
		t.Fatalf("ReadAt(v1) after confirm: %v", err)
	}
	if len(stillV1.Topology.Devices) != 1 {
		t.Fatalf("got %d devices at v1 after confirm, want 1", len(stillV1.Topology.Devices))
	}
}

func TestSnapshotCacheServesRepeatReads(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	v1, err := s.CurrentVersion(ctx)
	if err != nil {
		t.Fatalf("CurrentVersion: %v", err)
	}
	first, err := s.ReadAt(ctx, v1)
	if err != nil {
		t.Fatalf("ReadAt #1: %v", err)
	}
	second, err := s.ReadAt(ctx, v1)
	if err != nil {
		t.Fatalf("ReadAt #2: %v", err)
	}
	if len(first.Topology.Devices) != len(second.Topology.Devices) {
		t.Fatal("repeat reads of the same version disagree")
	}
	if len(s.snapshotCache) != 1 {
		t.Fatalf("snapshot cache holds %d entries, want 1", len(s.snapshotCache))
	}
}
