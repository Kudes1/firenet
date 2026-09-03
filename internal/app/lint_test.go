package app

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

func lintDocFixture() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{
				{Name: "r1", Kind: "router"},
				{Name: "r2", Kind: "router"},
			},
			Links: []projectdoc.LinkDoc{
				{A: projectdoc.EndpointDoc{Device: "r1"}, B: projectdoc.EndpointDoc{Device: "r2"}},
			},
			Networks: []projectdoc.NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []projectdoc.EndpointDoc{{Device: "r2"}}},
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
					{Name: "allow-all", Comment: "broad by design", Src: []string{"any"}, Dst: []string{"any"}, Proto: "any", Action: "allow"},
					{Name: "shadowed", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: "tcp", DstPorts: []string{"443"}, Action: "deny"},
				},
			}},
		},
	}
}

func TestLint_ReturnsFindingsFromValidPolicy(t *testing.T) {
	doc := lintDocFixture()
	topo, err := LoadProject(doc)
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	pol := doc.ToRules()
	findings, err := Lint(context.Background(), discardLogger(), topo, pol)
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	if len(findings) != 1 || findings[0].Rules[1] != "shadowed" {
		t.Fatalf("want the shadowed rule flagged unreachable, got %+v", findings)
	}
}

func TestLint_InvalidPolicyErrors(t *testing.T) {
	doc := lintDocFixture()
	topo, err := LoadProject(doc)
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{{Name: "bad", Src: []string{"no-such-subnet"}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow}},
	}}}
	if _, err := Lint(context.Background(), discardLogger(), topo, pol); err == nil {
		t.Fatal("want error for a rule referencing an unknown subnet")
	}
}
