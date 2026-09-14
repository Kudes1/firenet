package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestConfirmNoConflictsCreatesVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
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

	newVersion, conflicts, err := s.Confirm(ctx, d.ID, author)
	if err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("got conflicts %+v, want none", conflicts)
	}
	if newVersion <= v1 {
		t.Fatalf("got version %d, want > %d", newVersion, v1)
	}

	final, err := s.ReadAt(ctx, newVersion)
	if err != nil {
		t.Fatalf("ReadAt(newVersion): %v", err)
	}
	if len(final.Topology.Devices) != 2 {
		t.Fatalf("got %d devices in confirmed version, want 2", len(final.Topology.Devices))
	}

	confirmed, err := s.GetDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("GetDraft: %v", err)
	}
	if confirmed.Status != "merged" {
		t.Fatalf("got draft status %q, want merged", confirmed.Status)
	}
}

func TestConfirmDetectsConflictOnSharedEntity(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	// Two drafts from the same base, both touching r1.
	draftA, err := s.CreateDraft(ctx, author, "draft-a")
	if err != nil {
		t.Fatalf("CreateDraft A: %v", err)
	}
	draftB, err := s.CreateDraft(ctx, author, "draft-b")
	if err != nil {
		t.Fatalf("CreateDraft B: %v", err)
	}

	docA, revA, err := s.ReadDraft(ctx, draftA.ID)
	if err != nil {
		t.Fatalf("ReadDraft A: %v", err)
	}
	docA.Topology.Devices[0].Kind = "switch"
	if _, err := s.WriteDraft(ctx, draftA.ID, docA, revA); err != nil {
		t.Fatalf("WriteDraft A: %v", err)
	}
	if _, _, err := s.Confirm(ctx, draftA.ID, author); err != nil {
		t.Fatalf("Confirm A: %v", err)
	}

	docB, revB, err := s.ReadDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("ReadDraft B: %v", err)
	}
	docB.Topology.Devices[0].Kind = "firewall"
	if _, err := s.WriteDraft(ctx, draftB.ID, docB, revB); err != nil {
		t.Fatalf("WriteDraft B: %v", err)
	}

	conflicts, err := s.Conflicts(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("Conflicts: %v", err)
	}
	if len(conflicts) != 1 || conflicts[0].Key != "r1" {
		t.Fatalf("got %+v, want one conflict on r1", conflicts)
	}

	newVersion, confirmConflicts, err := s.Confirm(ctx, draftB.ID, author)
	if err != nil {
		t.Fatalf("Confirm B: %v", err)
	}
	if newVersion != 0 || len(confirmConflicts) != 1 {
		t.Fatalf("got version=%d conflicts=%+v, want a blocked confirm with 1 conflict", newVersion, confirmConflicts)
	}

	blocked, err := s.GetDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("GetDraft: %v", err)
	}
	if blocked.Status != "conflict" {
		t.Fatalf("got draft status %q, want conflict", blocked.Status)
	}
}

func TestConfirmAllowsDisjointConcurrentDrafts(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	draftA, err := s.CreateDraft(ctx, author, "draft-a")
	if err != nil {
		t.Fatalf("CreateDraft A: %v", err)
	}
	draftB, err := s.CreateDraft(ctx, author, "draft-b")
	if err != nil {
		t.Fatalf("CreateDraft B: %v", err)
	}

	docA, revA, err := s.ReadDraft(ctx, draftA.ID)
	if err != nil {
		t.Fatalf("ReadDraft A: %v", err)
	}
	docA.Topology.Devices[0].Kind = "switch" // touches r1
	if _, err := s.WriteDraft(ctx, draftA.ID, docA, revA); err != nil {
		t.Fatalf("WriteDraft A: %v", err)
	}
	if _, _, err := s.Confirm(ctx, draftA.ID, author); err != nil {
		t.Fatalf("Confirm A: %v", err)
	}

	docB, revB, err := s.ReadDraft(ctx, draftB.ID)
	if err != nil {
		t.Fatalf("ReadDraft B: %v", err)
	}
	docB.Topology.Devices[1].Kind = "firewall" // touches r2, disjoint from draft A
	if _, err := s.WriteDraft(ctx, draftB.ID, docB, revB); err != nil {
		t.Fatalf("WriteDraft B: %v", err)
	}

	newVersion, conflicts, err := s.Confirm(ctx, draftB.ID, author)
	if err != nil {
		t.Fatalf("Confirm B: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("got conflicts %+v, want none (disjoint entities)", conflicts)
	}
	if newVersion == 0 {
		t.Fatal("expected a new version")
	}
}
