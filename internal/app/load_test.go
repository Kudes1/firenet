package app

import (
	"strings"
	"testing"
)

func TestLoadProject_FilteredLinkReachableExports(t *testing.T) {
	topo, err := LoadProject([]byte(filteredChainTopology), []byte(filteredChainSubnets))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Links) != 2 {
		t.Fatalf("unexpected project: %+v", topo)
	}
}

func TestLoadProject_UnreachableFilterExport(t *testing.T) {
	// m exports NC it cannot reach: the only path to c runs through the
	// filtered link itself and o's side is behind another hop entirely.
	bad := strings.Replace(filteredChainTopology,
		"a-exports: [NA]", "a-exports: [NA, NC]", 1)
	_, err := LoadProject([]byte(bad), []byte(filteredChainSubnets))
	if err == nil || !strings.Contains(err.Error(), `export "NC" is not reachable`) {
		t.Fatalf("expected unreachable-export error, got: %v", err)
	}
}
