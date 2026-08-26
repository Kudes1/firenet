package app

import (
	"context"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

const lintAppTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const lintAppSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const lintAppRules = `
chains:
  - name: FIRENET-FWD
    defaultAction: deny
    chainPosition: top
    rules:
      - {name: allow-all, comment: "broad by design", src: [any], dst: [any], proto: any, action: allow}
      - {name: shadowed, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: deny}
`

func TestLint_ReturnsFindingsFromValidPolicy(t *testing.T) {
	topo, err := LoadProject([]byte(lintAppTopology), []byte(lintAppSubnets))
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	pol, err := rules.Load(strings.NewReader(lintAppRules))
	if err != nil {
		t.Fatalf("load rules: %v", err)
	}
	findings, err := Lint(context.Background(), discardLogger(), topo, pol)
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	if len(findings) != 1 || findings[0].Rules[1] != "shadowed" {
		t.Fatalf("want the shadowed rule flagged unreachable, got %+v", findings)
	}
}

func TestLint_InvalidPolicyErrors(t *testing.T) {
	topo, err := LoadProject([]byte(lintAppTopology), []byte(lintAppSubnets))
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
