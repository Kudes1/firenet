package app

import (
	"context"
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/rules"
)

const diagAppTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const diagAppSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const diagAppRules = `
defaultAction: deny
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

func TestDiagnose_MatchesCompileVerdicts(t *testing.T) {
	rep, err := Diagnose(context.Background(), discardLogger(), DiagnoseOptions{
		TopologyYAML: []byte(diagAppTopology),
		SubnetsYAML:  []byte(diagAppSubnets),
		RulesYAML:    []byte(diagAppRules),
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
		TopologyYAML: []byte(diagAppTopology),
		SubnetsYAML:  []byte(diagAppSubnets),
		RulesYAML:    []byte(diagAppRules),
		Flow: diagnose.Flow{
			Src: netip.MustParseAddr("10.0.0.5"),
			Dst: netip.MustParseAddr("192.168.99.99"),
		},
	})
	if err == nil || !strings.Contains(err.Error(), "не принадлежит") {
		t.Fatalf("want unknown-IP error, got %v", err)
	}
}
