package pgstore

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func TestSeedInitialVersionCreatesVersionOne(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()

	doc := projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{Devices: []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}}},
		Subnets:  projectdoc.SubnetsDoc{Subnets: []projectdoc.SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}},
		Rules:    projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{Name: "FIRENET-FWD", DefaultAction: "deny"}}},
	}

	v, err := s.SeedInitialVersion(ctx, doc, author)
	if err != nil {
		t.Fatalf("SeedInitialVersion: %v", err)
	}

	got, err := s.ReadAt(ctx, v)
	if err != nil {
		t.Fatalf("ReadAt: %v", err)
	}
	if len(got.Topology.Devices) != 1 || len(got.Subnets.Subnets) != 1 || len(got.Rules.Chains) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestSeedInitialVersionIsANoOpIfAlreadySeeded(t *testing.T) {
	s, author := newTestStoreWithUser(t)
	ctx := context.Background()
	first := insertVersion(t, s, author, map[entityRef]entityRow{
		{Kind: kindDevice, Key: "r1"}: {Change: "added", Data: []byte(`{"name":"r1"}`)},
	})

	second, err := s.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, author)
	if err != nil {
		t.Fatalf("SeedInitialVersion: %v", err)
	}
	if second != first {
		t.Fatalf("got %d, want %d (should be a no-op)", second, first)
	}
}
