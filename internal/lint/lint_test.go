package lint

import (
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

func TestCheck_CombinesAllChecksInDocumentedOrder(t *testing.T) {
	topo := testTopology()
	pol := &rules.Policy{Chains: []rules.Chain{
		{
			Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
			Rules: []rules.Rule{
				// "corp" (office+dmz) fully covers office->dmz, so this is
				// checkUnreachable's finding, not checkBroadAnyRule's (no
				// literal "any" endpoint here) nor checkConflict's (full
				// coverage is excluded from conflict).
				{Name: "allow-corp", Src: []string{"corp"}, Dst: []string{"corp"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
				{Name: "unreachable", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
			},
		},
		{Name: "ORPHAN", DefaultAction: rules.ActionDeny},
	}}
	got := Check(pol, topo)
	if len(got) != 2 {
		t.Fatalf("want 2 findings (unreachable rule + dead chain), got %+v", got)
	}
	if got[0].Chain != "FIRENET-FWD" || got[0].Rules[1] != "unreachable" {
		t.Fatalf("want the unreachable-rule finding first, got %+v", got[0])
	}
	if got[1].Chain != "ORPHAN" {
		t.Fatalf("want the dead-chain finding second, got %+v", got[1])
	}
}
