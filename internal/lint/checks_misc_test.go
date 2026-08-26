package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestCheckDeadChains(t *testing.T) {
	pol := &rules.Policy{Chains: []rules.Chain{
		{Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop, Rules: []rules.Rule{
			{Name: "go-limited", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionJump, JumpTo: "LIMITED"},
		}},
		{Name: "LIMITED", DefaultAction: rules.ActionDeny},
		{Name: "ORPHAN", DefaultAction: rules.ActionDeny},
	}}
	got := checkDeadChains(pol)
	if len(got) != 1 || got[0].Chain != "ORPHAN" {
		t.Fatalf("want ORPHAN flagged dead, got %+v", got)
	}
}

func TestCheckMirror_RedundantSelfOverlap(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(rules.Rule{Name: "r", Src: []string{"office"}, Dst: []string{"office"}, Proto: rules.ProtoAny, Action: rules.ActionAllow, Mirror: true})
	got := checkMirror(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "r" {
		t.Fatalf("want redundant-mirror finding, got %+v", got)
	}
}

func TestCheckMirror_ManualPairSuggestsMerge(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "office-to-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, SrcPorts: []string{"1024-65535"}, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		rules.Rule{Name: "dmz-to-office", Src: []string{"dmz"}, Dst: []string{"office"}, Proto: rules.ProtoTCP, SrcPorts: []string{"443"}, DstPorts: []string{"1024-65535"}, Action: rules.ActionAllow},
	)
	got := checkMirror(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "office-to-dmz" || got[0].Rules[1] != "dmz-to-office" {
		t.Fatalf("want manual-mirror-pair finding, got %+v", got)
	}
}

func TestCheckMirror_NoFindingWhenAlreadyMirrored(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(rules.Rule{Name: "r", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow, Mirror: true})
	if got := checkMirror(pol, topo); len(got) != 0 {
		t.Fatalf("mirror already set and no self-overlap: want no findings, got %+v", got)
	}
}

func TestCheckBroadAnyRule(t *testing.T) {
	pol := chainPolicy(
		rules.Rule{Name: "wide-open", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		rules.Rule{Name: "documented", Comment: "explicitly open by design", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
	)
	got := checkBroadAnyRule(pol)
	if len(got) != 1 || got[0].Rules[0] != "wide-open" {
		t.Fatalf("only the uncommented any/any rule should be flagged, got %+v", got)
	}
}
