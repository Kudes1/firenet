package cli

import (
	"path/filepath"
	"testing"

	"github.com/kudes1/firenet/internal/httpapi"
)

func testLegacyStore(t *testing.T) httpapi.FileProjectStore {
	t.Helper()
	dir := t.TempDir()
	return httpapi.FileProjectStore{
		TopologyPath: filepath.Join(dir, "topology.yaml"),
		SubnetsPath:  filepath.Join(dir, "subnets.yaml"),
		RulesPath:    filepath.Join(dir, "rules.yaml"),
		LayoutPath:   filepath.Join(dir, ".firenet-layout.json"),
	}
}

func TestLoadLegacyProjectDocMissingFilesYieldsDefaults(t *testing.T) {
	doc, err := loadLegacyProjectDoc(testLegacyStore(t))
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Topology.Devices) != 0 || len(doc.Subnets.Subnets) != 0 {
		t.Fatalf("expected empty topology/subnets, got %+v / %+v", doc.Topology, doc.Subnets)
	}
	if len(doc.Rules.Chains) != 1 || doc.Rules.Chains[0].DefaultAction != "deny" {
		t.Fatalf("expected one default-deny chain, got %+v", doc.Rules.Chains)
	}
}

func TestLoadLegacyProjectDocReadsExistingFiles(t *testing.T) {
	store := testLegacyStore(t)
	if err := store.WriteTopology([]byte("devices:\n  - {name: r1, kind: router}\nlinks: []\nnetworks: []\nsets: []\nunions: []\n")); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteSubnets([]byte("subnets:\n  - {name: office, cidr: 10.0.0.0/24}\n")); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteRules([]byte("defaultAction: deny\nrules: []\n")); err != nil {
		t.Fatal(err)
	}

	doc, err := loadLegacyProjectDoc(store)
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Topology.Devices) != 1 || doc.Topology.Devices[0].Name != "r1" {
		t.Fatalf("got devices %+v", doc.Topology.Devices)
	}
	if len(doc.Subnets.Subnets) != 1 || doc.Subnets.Subnets[0].Name != "office" {
		t.Fatalf("got subnets %+v", doc.Subnets.Subnets)
	}
}

func TestLoadLegacyProjectDocNormalizesFlatRulesFile(t *testing.T) {
	store := testLegacyStore(t)
	if err := store.WriteRules([]byte("defaultAction: deny\nchainName: OLD\nrules: []\n")); err != nil {
		t.Fatal(err)
	}

	doc, err := loadLegacyProjectDoc(store)
	if err != nil {
		t.Fatalf("loadLegacyProjectDoc: %v", err)
	}
	if len(doc.Rules.Chains) != 1 || doc.Rules.Chains[0].Name != "OLD" {
		t.Fatalf("legacy flat rules file not normalized: %+v", doc.Rules.Chains)
	}
}
