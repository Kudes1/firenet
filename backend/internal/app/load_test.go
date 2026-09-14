package app

import (
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func filterChainDoc(t *testing.T) projectdoc.ProjectDoc {
	t.Helper()
	var doc projectdoc.ProjectDoc
	doc.Topology.Devices = []projectdoc.DeviceDoc{
		{Name: "m", Kind: "router"}, {Name: "o", Kind: "router"}, {Name: "c", Kind: "router"},
	}
	doc.Topology.Networks = []projectdoc.NetworkDoc{
		{Name: "NA", Subnets: []string{"sa"}, Attach: []projectdoc.EndpointDoc{{Device: "m"}}},
		{Name: "NB", Subnets: []string{"sb"}, Attach: []projectdoc.EndpointDoc{{Device: "o"}}},
		{Name: "NC", Subnets: []string{"sc"}, Attach: []projectdoc.EndpointDoc{{Device: "c"}}},
	}
	doc.Topology.Links = []projectdoc.LinkDoc{
		{A: projectdoc.EndpointDoc{Device: "m"}, B: projectdoc.EndpointDoc{Device: "o"},
			Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		{A: projectdoc.EndpointDoc{Device: "o"}, B: projectdoc.EndpointDoc{Device: "c"},
			Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NB"}, BExports: []string{"NC"}}},
	}
	doc.Subnets.Subnets = []projectdoc.SubnetDoc{
		{Name: "sa", CIDR: "10.0.0.0/24"}, {Name: "sb", CIDR: "10.0.1.0/24"}, {Name: "sc", CIDR: "10.0.2.0/24"},
	}
	return doc
}

func TestLoadProject_FilteredLinkReachableExports(t *testing.T) {
	topo, err := LoadProject(filterChainDoc(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Links) != 2 {
		t.Fatalf("unexpected project: %+v", topo)
	}
}

func TestLoadProject_UnreachableFilterExport(t *testing.T) {
	bad := filterChainDoc(t)
	bad.Topology.Links[0].Filter.AExports = []string{"NA", "NC"}
	_, err := LoadProject(bad)
	if err == nil || !strings.Contains(err.Error(), `export "NC" is not reachable`) {
		t.Fatalf("expected unreachable-export error, got: %v", err)
	}
}
