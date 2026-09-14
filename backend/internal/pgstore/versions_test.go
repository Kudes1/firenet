package pgstore

import (
	"context"
	"errors"
	"testing"
)

func TestCurrentVersionNoVersions(t *testing.T) {
	s, _ := newTestStoreWithUser(t)
	if _, err := s.CurrentVersion(context.Background()); !errors.Is(err, ErrNoVersions) {
		t.Fatalf("got err %v, want ErrNoVersions", err)
	}
}

func TestCurrentVersionIsTheLatest(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	insertVersion(t, s, author, map[entityRef]entityRow{{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{}`)}})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{}`)}})

	got, err := s.CurrentVersion(context.Background())
	if err != nil {
		t.Fatalf("CurrentVersion: %v", err)
	}
	if got != v2 {
		t.Fatalf("got %d, want %d", got, v2)
	}
}

func TestReadAtReconstructsTheDoc(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}:     {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
		{Kind: kindSubnet, Key: "office"}: {Change: "added", Data: []byte(`{"name":"office","cidr":"10.0.0.0/24"}`)},
	})

	doc, err := s.ReadAt(context.Background(), v1)
	if err != nil {
		t.Fatalf("ReadAt: %v", err)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
	if len(doc.Subnets.Subnets) != 1 || doc.Subnets.Subnets[0].Name != "office" {
		t.Fatalf("got subnets %+v", doc.Subnets.Subnets)
	}
}

func TestHistoryOrdersNewestFirstAndRespectsLimit(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, nil)
	v2 := insertVersion(t, s, author, nil)
	v3 := insertVersion(t, s, author, nil)

	all, err := s.History(context.Background(), 10)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(all) != 3 || all[0].ID != v3 || all[2].ID != v1 {
		t.Fatalf("got %+v, want newest-first [%d,%d,%d]", all, v3, v2, v1)
	}

	limited, err := s.History(context.Background(), 2)
	if err != nil {
		t.Fatalf("History(limit=2): %v", err)
	}
	if len(limited) != 2 || limited[0].ID != v3 {
		t.Fatalf("got %+v, want the 2 newest", limited)
	}
}

func TestDiffVersions(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	v1 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1","kind":"router"}`)},
	})
	v2 := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r2"}: {Change: "added", Data: []byte(`{"name":"r2","kind":"router"}`)},
	})

	diffs, err := s.DiffVersions(context.Background(), v1, v2)
	if err != nil {
		t.Fatalf("DiffVersions: %v", err)
	}
	if len(diffs) != 1 || diffs[0].Key != "r2" || diffs[0].Change != "added" {
		t.Fatalf("got %+v", diffs)
	}
}
