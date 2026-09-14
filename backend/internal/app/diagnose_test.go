package app

import (
	"context"
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

func diagDocFixture() projectdoc.ProjectDoc {
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
					{Name: "office-to-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: "tcp", DstPorts: []string{"443"}, Action: "allow"},
				},
			}},
		},
	}
}

func TestDiagnose_MatchesCompileVerdicts(t *testing.T) {
	rep, err := Diagnose(context.Background(), discardLogger(), DiagnoseOptions{
		Doc: diagDocFixture(),
		Flow: diagnose.Flow{
			Src:      netip.MustParseAddr("10.0.0.5"),
			Dst:      netip.MustParseAddr("10.0.1.7"),
			Proto:    rules.ProtoTCP,
			DstPorts: []string{"443"},
		},
	})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" || len(rep.Paths) != 1 {
		t.Fatalf("unexpected report: %+v", rep)
	}
	p := rep.Paths[0]
	if p.Verdict != rules.ActionAllow || len(p.Routers) != 2 {
		t.Fatalf("want allowed path via 2 routers, got %+v", p)
	}
	if p.Routers[0].MatchedRule != "office-to-dmz" {
		t.Fatalf("want office-to-dmz, got %+v", p.Routers[0])
	}
}

func TestDiagnose_UnknownIPErrors(t *testing.T) {
	_, err := Diagnose(context.Background(), discardLogger(), DiagnoseOptions{
		Doc: diagDocFixture(),
		Flow: diagnose.Flow{
			Src: netip.MustParseAddr("10.0.0.5"),
			Dst: netip.MustParseAddr("192.168.99.99"),
		},
	})
	if err == nil || !strings.Contains(err.Error(), "не принадлежит") {
		t.Fatalf("want unknown-IP error, got %v", err)
	}
}
