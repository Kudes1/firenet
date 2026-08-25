package diagnose_test

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

const diagTopology = `
devices:
  - {name: r1, kind: router}
  - {name: r2, kind: router}
links:
  - {a: {device: r1}, b: {device: r2}}
networks:
  - {name: n-office, subnets: [office], attach: [{device: r1}]}
  - {name: n-dmz, subnets: [dmz], attach: [{device: r2}]}
`

const diagSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
  - {name: isolated, cidr: 10.0.2.0/24}
`

const diagRulesAllow = `
defaultAction: deny
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: office-to-dmz, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

const diagRulesDeny = `
defaultAction: allow
chainName: FIRENET-FWD
chainPosition: top
rules:
  - {name: block-dmz, src: [office], dst: [dmz], action: deny}
`

const diagRulesReturnRule = `
defaultAction: deny
chainName: MY-CHAIN
chainPosition: top
rules:
  - {name: bypass-office-dmz, src: [office], dst: [dmz], action: return}
`

const diagRulesDefaultReturn = `
defaultAction: return
chainName: MY-CHAIN
chainPosition: top
rules:
  - {name: unrelated, src: [dmz], dst: [office], proto: udp, action: allow}
`

func loadTopo(t *testing.T) (*topology.Topology, *graph.Graph) {
	t.Helper()
	topo, err := topology.Load(strings.NewReader(diagTopology))
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := topology.LoadSubnets(strings.NewReader(diagSubnets))
	if err != nil {
		t.Fatalf("load subnets: %v", err)
	}
	topo.Subnets = subs
	if err := topo.Validate(); err != nil {
		t.Fatalf("validate topology: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	return topo, g
}

func compilePolicy(t *testing.T, topo *topology.Topology, g *graph.Graph, policyYAML string) []compiler.DeviceRuleset {
	t.Helper()
	pol, err := rules.Load(strings.NewReader(policyYAML))
	if err != nil {
		t.Fatalf("load rules: %v", err)
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("validate rules: %v", err)
	}
	sets, err := compiler.Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return sets
}

func runDiag(t *testing.T, policyYAML string, src, dst string, proto rules.Proto, dstPorts ...string) *diagnose.Report {
	t.Helper()
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, policyYAML)
	flow := diagnose.Flow{
		Src:      netip.MustParseAddr(src),
		Dst:      netip.MustParseAddr(dst),
		Proto:    proto,
		DstPorts: dstPorts,
	}
	rep, err := diagnose.Run(topo, sets, g, graph.DefaultLimits(), flow)
	if err != nil {
		t.Fatalf("diagnose.Run: %v", err)
	}
	return rep
}

func TestResolveIP_SubnetAndError(t *testing.T) {
	topo, _ := loadTopo(t)
	name, err := diagnose.ResolveIP(topo, netip.MustParseAddr("10.0.0.5"))
	if err != nil || name != "office" {
		t.Fatalf("want office, got %q, %v", name, err)
	}
	if _, err := diagnose.ResolveIP(topo, netip.MustParseAddr("192.168.99.99")); err == nil {
		t.Fatal("unknown IP must fail")
	}
}

func TestRun_AllowedPath(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	if rep.SrcSubnet != "office" || rep.DstSubnet != "dmz" {
		t.Fatalf("endpoint resolution wrong: %+v", rep)
	}
	if len(rep.Paths) != 1 {
		t.Fatalf("want 1 path, got %d", len(rep.Paths))
	}
	p := rep.Paths[0]
	if p.Verdict != rules.ActionAllow {
		t.Fatalf("want allow, got %q (routers %+v)", p.Verdict, p.Routers)
	}
	if len(p.Routers) != 2 {
		t.Fatalf("want 2 transit routers, got %+v", p.Routers)
	}
	for _, v := range p.Routers {
		if v.MatchedRule != "office-to-dmz" || v.Action != rules.ActionAllow || v.Reason == "" {
			t.Fatalf("bad verdict on %s: %+v", v.Router, v)
		}
	}
}

func TestRun_DeniedPathOverridesDefault(t *testing.T) {
	rep := runDiag(t, diagRulesDeny, "10.0.0.5", "10.0.1.7", "")
	if len(rep.Paths) != 1 || rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("want denied path, got %+v", rep.Paths)
	}
	for _, v := range rep.Paths[0].Routers {
		if v.MatchedRule != "block-dmz" {
			t.Fatalf("router %s: want block-dmz, got %+v", v.Router, v)
		}
	}
}

func TestRun_UnspecifiedPortFallsToDefault(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.1.7", "")
	if len(rep.Paths) != 1 || rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("unspecified ports must fall to default deny, got %+v", rep.Paths)
	}
	v := rep.Paths[0].Routers[0]
	if v.MatchedRule != "" || v.Reason == "" {
		t.Fatalf("want default-action explanation, got %+v", v)
	}
}

func TestRun_NoMatchingRuleFallsToDefault(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoUDP)
	if len(rep.Paths) != 1 || rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("udp must fall to default deny, got %+v", rep.Paths)
	}
	v := rep.Paths[0].Routers[0]
	if v.MatchedRule != "" || v.Reason == "" {
		t.Fatalf("want default-action explanation, got %+v", v)
	}
}

func TestRun_ReturnRuleYieldsReturnVerdict(t *testing.T) {
	rep := runDiag(t, diagRulesReturnRule, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	if len(rep.Paths) != 1 {
		t.Fatalf("want 1 path, got %d", len(rep.Paths))
	}
	p := rep.Paths[0]
	if p.Verdict != rules.ActionReturn {
		t.Fatalf("want return path verdict, got %q (routers %+v)", p.Verdict, p.Routers)
	}
	for _, v := range p.Routers {
		if v.MatchedRule != "bypass-office-dmz" || v.Action != rules.ActionReturn || v.Reason == "" {
			t.Fatalf("bad verdict on %s: %+v", v.Router, v)
		}
		if !strings.Contains(v.Reason, "MY-CHAIN") || !strings.Contains(v.Reason, "FORWARD") {
			t.Fatalf("reason must name the chain and FORWARD, got: %s", v.Reason)
		}
	}
}

func TestRun_DefaultReturnWhenNoMatch(t *testing.T) {
	rep := runDiag(t, diagRulesDefaultReturn, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	p := rep.Paths[0]
	if p.Verdict != rules.ActionReturn {
		t.Fatalf("want return path verdict, got %q (routers %+v)", p.Verdict, p.Routers)
	}
	for _, v := range p.Routers {
		if v.MatchedRule != "" || v.Action != rules.ActionReturn {
			t.Fatalf("router %s: want default-return verdict, got %+v", v.Router, v)
		}
		if !strings.Contains(v.Reason, "MY-CHAIN") || !strings.Contains(v.Reason, "FORWARD") {
			t.Fatalf("reason must name the chain and FORWARD, got: %s", v.Reason)
		}
	}
}

func TestRun_DenyOverridesReturnOnPath(t *testing.T) {
	rep := runDiag(t, diagRulesDeny, "10.0.0.5", "10.0.1.7", "")
	if rep.Paths[0].Verdict != rules.ActionDeny {
		t.Fatalf("deny must override return on path verdict, got %+v", rep.Paths[0])
	}
}

func TestRun_UnreachableIsEmptyNotError(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.2.7", "")
	if len(rep.Paths) != 0 {
		t.Fatalf("isolated subnet must yield zero paths, got %+v", rep.Paths)
	}
}

// Пустые списки обязаны маршалиться в [] а не null: фронтенд вызывает
// .length/.forEach прямо на paths и routers.
func TestRun_JSONNeverNullArrays(t *testing.T) {
	for _, tc := range []struct {
		name string
		rep  *diagnose.Report
	}{
		{"unreachable", runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.2.7", "")},
		{"same-subnet", runDiag(t, diagRulesAllow, "10.0.0.1", "10.0.0.200", "")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.rep)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			s := string(b)
			if strings.Contains(s, ":null") {
				t.Fatalf("JSON contains null array: %s", s)
			}
		})
	}
}

func TestRun_SameSubnetIsL2(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.1", "10.0.0.200", "")
	if len(rep.Paths) != 1 {
		t.Fatalf("same-subnet must yield one degenerate path, got %+v", rep.Paths)
	}
	p := rep.Paths[0]
	if len(p.Nodes) != 1 || len(p.Routers) != 0 || p.Note == "" {
		t.Fatalf("degenerate path expected, got %+v", p)
	}
}
