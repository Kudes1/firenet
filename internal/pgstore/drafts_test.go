package pgstore

import (
	"context"
	"errors"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestCreateDraftFromCurrentVersion(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})

	d, err := s.CreateDraft(context.Background(), author, "my-changes")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if d.BaseVersionID != v1 || d.Status != "open" || d.Revision != 0 {
		t.Fatalf("unexpected draft: %+v", d)
	}
}

func TestCreateDraftDuplicateName(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	insertVersion(t, s, author, nil)
	ctx := context.Background()

	if _, err := s.CreateDraft(ctx, author, "dup"); err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := s.CreateDraft(ctx, author, "dup"); !errors.Is(err, ErrDraftNameTaken) {
		t.Fatalf("got err %v, want ErrDraftNameTaken", err)
	}
}

func TestReadDraftMergesBaseAndOverrides(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
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
	if revision != "0" {
		t.Fatalf("got revision %q, want \"0\"", revision)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
}

func TestWriteDraftPersistsOnlyRealDiffsAndBumpsRevision(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
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
	newRevision, err := s.WriteDraft(ctx, d.ID, doc, revision)
	if err != nil {
		t.Fatalf("WriteDraft: %v", err)
	}
	if newRevision != "1" {
		t.Fatalf("got revision %q, want \"1\"", newRevision)
	}

	overrides, err := s.draftOverrides(ctx, d.ID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 1 {
		t.Fatalf("got %d overrides, want 1 (only r2 differs from base)", len(overrides))
	}

	// Writing the same doc again (no actual change) should clear the
	// override back out once it's reverted to match base.
	doc.Topology.Devices = doc.Topology.Devices[:1] // drop r2 again
	finalRevision, err := s.WriteDraft(ctx, d.ID, doc, newRevision)
	if err != nil {
		t.Fatalf("WriteDraft (revert): %v", err)
	}
	if finalRevision != "2" {
		t.Fatalf("got revision %q, want \"2\"", finalRevision)
	}
	overrides, err = s.draftOverrides(ctx, d.ID)
	if err != nil {
		t.Fatalf("draftOverrides: %v", err)
	}
	if len(overrides) != 0 {
		t.Fatalf("got %d overrides, want 0 (draft reverted to base)", len(overrides))
	}
}

func TestWriteDraftRevisionMismatch(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	doc, _, err := s.ReadDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("ReadDraft: %v", err)
	}

	if _, err := s.WriteDraft(ctx, d.ID, doc, "999"); !errors.Is(err, ErrRevisionMismatch) {
		t.Fatalf("got err %v, want ErrRevisionMismatch", err)
	}
}

func TestDeleteDraft(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	d, err := s.CreateDraft(ctx, author, "wip")
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	if err := s.DeleteDraft(ctx, d.ID); err != nil {
		t.Fatalf("DeleteDraft: %v", err)
	}
	if err := s.DeleteDraft(ctx, d.ID); !errors.Is(err, ErrDraftNotFound) {
		t.Fatalf("got err %v, want ErrDraftNotFound on double-delete", err)
	}
}

func TestListDraftsFiltersByOwner(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, nil)
	if _, err := s.CreateDraft(ctx, author, "a"); err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}

	mine, err := s.ListDrafts(ctx, &author)
	if err != nil {
		t.Fatalf("ListDrafts: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("got %d drafts, want 1", len(mine))
	}

	all, err := s.ListDrafts(ctx, nil)
	if err != nil {
		t.Fatalf("ListDrafts(nil): %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("got %d drafts, want 1", len(all))
	}
}

func TestDiffDraft(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	insertVersion(t, s, author, map[entityRef]entityRow{
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

	diffs, err := s.DiffDraft(ctx, d.ID)
	if err != nil {
		t.Fatalf("DiffDraft: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Key != "r2" || diffs[0].Change != "added" {
		t.Fatalf("got %+v", diffs)
	}
}
