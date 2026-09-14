package app

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func e2eDoc() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{
				{Name: "r1", Kind: "router"},
				{Name: "r2", Kind: "router"},
			},
			Networks: []projectdoc.NetworkDoc{
				{Name: "office", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}, {Device: "r2"}}},
				{Name: "dmz", Subnets: []string{"dmz"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}, {Device: "r2"}}},
			},
		},
		Subnets: projectdoc.SubnetsDoc{
			Subnets: []projectdoc.SubnetDoc{
				{Name: "office", CIDR: "10.0.0.0/24"},
				{Name: "dmz", CIDR: "10.0.1.0/24"},
			},
		},
		Rules: projectdoc.PolicyDoc{
			Chains: []projectdoc.ChainDoc{{
				Name:          "FIRENET-FWD",
				DefaultAction: "deny",
				ChainPosition: "top",
				Rules: []projectdoc.RuleDoc{
					{Name: "office-to-dmz-https", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: "tcp", DstPorts: []string{"443"}, Action: "allow"},
				},
			}},
		},
	}
}

func TestCompile_EndToEnd(t *testing.T) {
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: e2eDoc(),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d devices, want 2", len(out))
	}
	for _, d := range out {
		if !strings.Contains(d.RulesScript, "FIRENET-FWD") {
			t.Fatalf("%s: missing chain setup in rules script:\n%s", d.Name, d.RulesScript)
		}
		if !strings.Contains(d.RulesScript, "-p tcp") {
			t.Fatalf("%s: expected redundant router to carry the rule, got:\n%s", d.Name, d.RulesScript)
		}
		if !strings.Contains(d.IPSetsScript, "10.0.0.0/24") || !strings.Contains(d.IPSetsScript, "10.0.1.0/24") {
			t.Fatalf("%s: missing expected ipset members:\n%s", d.Name, d.IPSetsScript)
		}
	}
}

func TestCompile_InvalidTopologyFailsFast(t *testing.T) {
	doc := e2eDoc()
	doc.Topology.Devices = []projectdoc.DeviceDoc{{Name: "r1", Kind: "bogus"}}
	_, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: doc,
	})
	if err == nil {
		t.Fatal("expected error for invalid device kind")
	}
}

func TestLoadProject_OK(t *testing.T) {
	topo, err := LoadProject(e2eDoc())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Subnets) != 2 || len(topo.Networks) != 2 {
		t.Fatalf("unexpected project: %+v", topo)
	}
}

func TestLoadProject_SubnetInTwoNetworks(t *testing.T) {
	doc := projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}},
			Networks: []projectdoc.NetworkDoc{
				{Name: "n1", Subnets: []string{"a"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
				{Name: "n2", Subnets: []string{"a"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
			},
		},
		Subnets: projectdoc.SubnetsDoc{
			Subnets: []projectdoc.SubnetDoc{{Name: "a", CIDR: "10.0.0.0/24"}},
		},
	}
	_, err := LoadProject(doc)
	if err == nil || !strings.Contains(err.Error(), "both network") {
		t.Fatalf("expected cross-file ownership error, got: %v", err)
	}
}

func TestLoadProject_UnknownNetworkSubnet(t *testing.T) {
	doc := e2eDoc()
	doc.Topology.Networks = []projectdoc.NetworkDoc{
		{Name: "n1", Subnets: []string{"ghost"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
	}
	_, err := LoadProject(doc)
	if err == nil || !strings.Contains(err.Error(), "unknown subnet") {
		t.Fatalf("expected unknown subnet error, got: %v", err)
	}
}

func filteredChainDocFixture() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{
				{Name: "m", Kind: "router"},
				{Name: "d", Kind: "router"},
				{Name: "o", Kind: "router"},
			},
			Links: []projectdoc.LinkDoc{
				{
					A:      projectdoc.EndpointDoc{Device: "m"},
					B:      projectdoc.EndpointDoc{Device: "d"},
					Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NA"}, BExports: []string{"NB"}},
				},
				{
					A: projectdoc.EndpointDoc{Device: "d"},
					B: projectdoc.EndpointDoc{Device: "o"},
				},
			},
			Networks: []projectdoc.NetworkDoc{
				{Name: "NA", Subnets: []string{"a"}, Attach: []projectdoc.EndpointDoc{{Device: "m"}}},
				{Name: "NB", Subnets: []string{"b"}, Attach: []projectdoc.EndpointDoc{{Device: "d"}}},
				{Name: "NC", Subnets: []string{"c"}, Attach: []projectdoc.EndpointDoc{{Device: "o"}}},
			},
		},
		Subnets: projectdoc.SubnetsDoc{
			Subnets: []projectdoc.SubnetDoc{
				{Name: "a", CIDR: "10.0.10.0/24"},
				{Name: "b", CIDR: "10.0.11.0/24"},
				{Name: "c", CIDR: "10.0.12.0/24"},
			},
		},
	}
}

func TestCompile_FilteredLinkBlocksUnannouncedPair(t *testing.T) {
	doc := filteredChainDocFixture()
	doc.Rules = projectdoc.PolicyDoc{
		Chains: []projectdoc.ChainDoc{{
			Name:          "FIRENET-FWD",
			DefaultAction: "deny",
			Rules: []projectdoc.RuleDoc{
				{Name: "blocked", Src: []string{"NA"}, Dst: []string{"NC"}, Action: "allow"},
			},
		}},
	}
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: doc,
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("unannounced pair must place no rules, got devices: %v", names(out))
	}
}

func TestCompile_FilteredLinkKeepsAnnouncedPair(t *testing.T) {
	doc := filteredChainDocFixture()
	doc.Rules = projectdoc.PolicyDoc{
		Chains: []projectdoc.ChainDoc{{
			Name:          "FIRENET-FWD",
			DefaultAction: "deny",
			Rules: []projectdoc.RuleDoc{
				{Name: "allowed", Src: []string{"NB"}, Dst: []string{"NC"}, Action: "allow"},
			},
		}},
	}
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: doc,
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("announced pair places on %v, want %v", got, want)
	}
}

func chainedReExportDocFixture() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{
				{Name: "m", Kind: "router"},
				{Name: "d", Kind: "router"},
				{Name: "o", Kind: "router"},
			},
			Links: []projectdoc.LinkDoc{
				{
					A:      projectdoc.EndpointDoc{Device: "m"},
					B:      projectdoc.EndpointDoc{Device: "d"},
					Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NA"}, BExports: []string{"NB"}},
				},
				{
					A:      projectdoc.EndpointDoc{Device: "o"},
					B:      projectdoc.EndpointDoc{Device: "d"},
					Filter: &projectdoc.LinkFilterDoc{AExports: []string{"NC"}, BExports: []string{"NB", "NA"}},
				},
			},
			Networks: []projectdoc.NetworkDoc{
				{Name: "NA", Subnets: []string{"a"}, Attach: []projectdoc.EndpointDoc{{Device: "m"}}},
				{Name: "NB", Subnets: []string{"b"}, Attach: []projectdoc.EndpointDoc{{Device: "d"}}},
				{Name: "NC", Subnets: []string{"c"}, Attach: []projectdoc.EndpointDoc{{Device: "o"}}},
			},
		},
		Subnets: projectdoc.SubnetsDoc{
			Subnets: []projectdoc.SubnetDoc{
				{Name: "a", CIDR: "10.0.20.0/24"},
				{Name: "b", CIDR: "10.0.21.0/24"},
				{Name: "c", CIDR: "10.0.22.0/24"},
			},
		},
	}
}

// d re-exports NA (learned from m) toward o (b-exports includes NA on the
// o-d link) — o can now reach m. Nothing announces NC back toward m on the
// m-d link, so the reverse direction has no route at all: filtered links
// model per-direction route advertisement, not a symmetric ACL pair.
func TestCompile_ChainedReExportPlacesRuleForWorkingDirection(t *testing.T) {
	doc := chainedReExportDocFixture()
	doc.Rules = projectdoc.PolicyDoc{
		Chains: []projectdoc.ChainDoc{{
			Name:          "FIRENET-FWD",
			DefaultAction: "deny",
			Rules: []projectdoc.RuleDoc{
				{Name: "office-to-market", Src: []string{"NC"}, Dst: []string{"NA"}, Action: "allow"},
			},
		}},
	}
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: doc,
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "m", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("chained re-export places on %v, want %v", got, want)
	}
}

func TestCompile_ChainedReExportPlacesNoRuleWithoutSymmetricAnnouncement(t *testing.T) {
	doc := chainedReExportDocFixture()
	doc.Rules = projectdoc.PolicyDoc{
		Chains: []projectdoc.ChainDoc{{
			Name:          "FIRENET-FWD",
			DefaultAction: "deny",
			Rules: []projectdoc.RuleDoc{
				{Name: "market-to-office", Src: []string{"NA"}, Dst: []string{"NC"}, Action: "allow"},
			},
		}},
	}
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		Doc: doc,
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("market has no route back to office without a symmetric announcement, got devices: %v", names(out))
	}
}

func names(out []CompiledDevice) []string {
	var s []string
	for _, d := range out {
		s = append(s, d.Name)
	}
	return s
}
