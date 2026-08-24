package rules

import (
	"strings"
	"testing"
)

func TestLoad_RuleComment(t *testing.T) {
	in := `
defaultAction: deny
rules:
  - name: db-access
    comment: доступ к БД
    src: [A]
    dst: [B]
    action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(pol.Primary().Rules) != 1 {
		t.Fatalf("got %d rules, want 1", len(pol.Primary().Rules))
	}
	if pol.Primary().Rules[0].Comment != "доступ к БД" {
		t.Fatalf("Comment = %q, want %q", pol.Primary().Rules[0].Comment, "доступ к БД")
	}
}

func TestLoadChainsFormat(t *testing.T) {
	in := `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - name: to-restricted
        src: [dangerous]
        dst: [any]
        action: jump
        jumpTo: FIRENET-RESTRICTED
  - name: FIRENET-RESTRICTED
    defaultAction: return
    rules:
      - name: restricted-dns
        src: [dangerous]
        dst: [dns]
        proto: udp
        dstPorts: ["53"]
        action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(pol.Chains) != 2 {
		t.Fatalf("chains = %d, want 2", len(pol.Chains))
	}
	sub := pol.Primary().Rules[0]
	if sub.Action != ActionJump || sub.JumpTo != "FIRENET-RESTRICTED" {
		t.Fatalf("bad primary rule: %+v", sub)
	}
	if pol.Chains[1].DefaultAction != ActionReturn {
		t.Fatalf("second chain default = %q", pol.Chains[1].DefaultAction)
	}
}

func TestLoadLegacyFlatFormat(t *testing.T) {
	in := `
defaultAction: allow
chainName: MYCHAIN
chainPosition: bottom
rules:
  - name: web
    src: [office]
    dst: [web-srv]
    action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	c := pol.Primary()
	if len(pol.Chains) != 1 || c.Name != "MYCHAIN" || c.DefaultAction != ActionAllow || c.ChainPosition != ChainBottom || len(c.Rules) != 1 {
		t.Fatalf("legacy load mismatch: %+v", pol)
	}
}
