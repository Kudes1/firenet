package pgstore

import (
	"context"
	"testing"
)

func TestRestoreRecreatesOldContentAsANewVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "modified", Data: []byte(`{"name":"r1","kind":"switch"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	v3, err := s.Restore(ctx, v1, author)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if v3 <= v2 {
		t.Fatalf("got version %d, want > %d", v3, v2)
	}

	restored, err := s.ReadAt(ctx, v3)
	if err != nil {
		t.Fatalf("ReadAt(v3): %v", err)
	}
	if len(restored.Topology.Devices) != 1 || restored.Topology.Devices[0].Name != "r1" || restored.Topology.Devices[0].Kind != "router" {
		t.Fatalf("got %+v, want only r1/router restored from v1", restored.Topology.Devices)
	}

	history, err := s.History(ctx, 1)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history) != 1 || history[0].Note == "" {
		t.Fatalf("got %+v, want the newest version to carry a restore note", history)
	}
}

func TestRestoreToCurrentIsANoOp(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})

	got, err := s.Restore(ctx, v1, author)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got != v1 {
		t.Fatalf("got %d, want %d (no new version needed)", got, v1)
	}
}
