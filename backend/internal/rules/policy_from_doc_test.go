package rules_test

import (
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

func TestToPolicy_RuleComment(t *testing.T) {
	doc := projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
		DefaultAction: "deny",
		Rules: []projectdoc.RuleDoc{{
			Name: "db-access", Comment: "доступ к БД",
			Src: []string{"A"}, Dst: []string{"B"}, Action: "allow",
		}},
	}}}
	pol := doc.ToPolicy()
	if len(pol.Primary().Rules) != 1 {
		t.Fatalf("got %d rules, want 1", len(pol.Primary().Rules))
	}
	if pol.Primary().Rules[0].Comment != "доступ к БД" {
		t.Fatalf("Comment = %q, want %q", pol.Primary().Rules[0].Comment, "доступ к БД")
	}
}

func TestToPolicy_ChainsFormat(t *testing.T) {
	doc := projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{
		{Name: "FIRENET-FWD", DefaultAction: "deny", ChainPosition: "top",
			Rules: []projectdoc.RuleDoc{{
				Name: "to-restricted", Src: []string{"dangerous"}, Dst: []string{"any"},
				Action: "jump", JumpTo: "FIRENET-RESTRICTED",
			}}},
		{Name: "FIRENET-RESTRICTED", DefaultAction: "return",
			Rules: []projectdoc.RuleDoc{{
				Name: "restricted-dns", Src: []string{"dangerous"}, Dst: []string{"dns"},
				Proto: "udp", DstPorts: []string{"53"}, Action: "allow",
			}}},
	}}
	pol := doc.ToPolicy()
	if len(pol.Chains) != 2 {
		t.Fatalf("chains = %d, want 2", len(pol.Chains))
	}
	sub := pol.Primary().Rules[0]
	if sub.Action != rules.ActionJump || sub.JumpTo != "FIRENET-RESTRICTED" {
		t.Fatalf("bad primary rule: %+v", sub)
	}
	if pol.Chains[1].DefaultAction != rules.ActionReturn {
		t.Fatalf("second chain default = %q", pol.Chains[1].DefaultAction)
	}
}
