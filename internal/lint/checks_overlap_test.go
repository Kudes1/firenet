package lint

import (
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

// chainPolicy wraps rs in a single primary chain, for tests that only
// care about rule-level behavior within one chain.
func chainPolicy(rs ...rules.Rule) *rules.Policy {
	return &rules.Policy{Chains: []rules.Chain{{Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop, Rules: rs}}}
}

func TestCheckUnreachable_DuplicateRule(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "broad", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		rules.Rule{Name: "narrow", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
	)
	got := checkUnreachable(pol, topo)
	if len(got) != 1 || got[0].Rules[0] != "broad" || got[0].Rules[1] != "narrow" {
		t.Fatalf("want one unreachable finding for narrow, got %+v", got)
	}
	if !strings.Contains(got[0].Message, "никогда не применяется") {
		t.Fatalf("message should explain unreachability: %q", got[0].Message)
	}
}

func TestCheckUnreachable_DifferentActionStillUnreachable(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "deny-all", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		rules.Rule{Name: "allow-office", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
	)
	got := checkUnreachable(pol, topo)
	if len(got) != 1 || got[0].Rules[1] != "allow-office" {
		t.Fatalf("want allow-office flagged unreachable, got %+v", got)
	}
}

func TestCheckUnreachable_NoOverlapNoFinding(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "a", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		rules.Rule{Name: "b", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"80"}, Action: rules.ActionAllow},
	)
	if got := checkUnreachable(pol, topo); len(got) != 0 {
		t.Fatalf("disjoint ports must not be unreachable: %+v", got)
	}
}

func TestCheckConflict_PartialOverlapDifferentAction(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "allow-443-8080", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"443", "8080"}, Action: rules.ActionAllow},
		rules.Rule{Name: "deny-8080-9090", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoTCP, DstPorts: []string{"8080", "9090"}, Action: rules.ActionDeny},
	)
	got := checkConflict(pol, topo)
	if len(got) != 1 {
		t.Fatalf("want one conflict finding, got %+v", got)
	}
}

func TestCheckConflict_FullCoverageIsNotConflict(t *testing.T) {
	topo := testTopology()
	pol := chainPolicy(
		rules.Rule{Name: "allow-all", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		rules.Rule{Name: "deny-office", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
	)
	if got := checkConflict(pol, topo); len(got) != 0 {
		t.Fatalf("full coverage is checkUnreachable's finding, not a conflict: %+v", got)
	}
}
