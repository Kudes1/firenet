package diagnose_test

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/projectdoc"
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

var diagRulesAllow = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "deny", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "office-to-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: "tcp", DstPorts: []string{"443"}, Action: "allow"}},
}}}

var diagRulesDeny = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "allow", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "block-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Action: "deny"}},
}}}

var diagRulesReturnRule = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "MY-CHAIN", DefaultAction: "deny", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "bypass-office-dmz", Src: []string{"office"}, Dst: []string{"dmz"}, Action: "return"}},
}}}

var diagRulesDefaultReturn = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "MY-CHAIN", DefaultAction: "return", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "unrelated", Src: []string{"dmz"}, Dst: []string{"office"}, Proto: "udp", Action: "allow"}},
}}}

var diagRulesAllowBothWays = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "allow", ChainPosition: "top", Rules: []projectdoc.RuleDoc{},
}}}

var diagRulesMirror = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "deny", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "office-dmz-both-ways", Src: []string{"office"}, Dst: []string{"dmz"}, Proto: "tcp", DstPorts: []string{"443"}, Action: "allow", Mirror: true}},
}}}

func loadTopo(t *testing.T) (*topology.Topology, *graph.Graph) {
	t.Helper()
	tdoc := projectdoc.TopologyDoc{
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
	}
	sdoc := projectdoc.SubnetsDoc{
		Subnets: []projectdoc.SubnetDoc{
			{Name: "office", CIDR: "10.0.0.0/24"},
			{Name: "dmz", CIDR: "10.0.1.0/24"},
			{Name: "isolated", CIDR: "10.0.2.0/24"},
		},
	}
	topo, err := tdoc.ToTopology()
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := sdoc.ToSubnets()
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

func compilePolicy(t *testing.T, topo *topology.Topology, g *graph.Graph, doc projectdoc.PolicyDoc) []compiler.DeviceRuleset {
	t.Helper()
	pol := doc.ToPolicy()
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("validate rules: %v", err)
	}
	sets, err := compiler.Compile(topo, &pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return sets
}

func runDiag(t *testing.T, doc projectdoc.PolicyDoc, src, dst string, proto rules.Proto, dstPorts ...string) *diagnose.Report {
	t.Helper()
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, doc)
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

// A one-directional rule (no mirror) permits office->dmz but leaves dmz->office
// on the default deny: the network path back exists (Build mirrors every
// filtered-link Allow), but firewall policy makes it one-way.
func TestRun_ReturnPathAllowed_FalseForOneDirectionalRule(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	if rep.ReturnPathAllowed {
		t.Fatal("one-directional rule must not report a return path")
	}
}

func TestRun_ReturnPathAllowed_TrueWhenDefaultAllowsBothWays(t *testing.T) {
	rep := runDiag(t, diagRulesAllowBothWays, "10.0.0.5", "10.0.1.7", "")
	if !rep.ReturnPathAllowed {
		t.Fatal("default-allow policy must permit traffic both ways")
	}
}

func TestRun_ReturnPathAllowed_TrueWithMirroredRule(t *testing.T) {
	rep := runDiag(t, diagRulesMirror, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	if !rep.ReturnPathAllowed {
		t.Fatal("mirrored rule must permit the return direction too")
	}
}

func TestRun_ReturnPathAllowed_TrueForSameSubnet(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.0.9", "")
	if !rep.ReturnPathAllowed {
		t.Fatal("same L2 segment must trivially allow return traffic")
	}
}

func TestRun_ReturnPathAllowed_FalseWhenFullyUnreachable(t *testing.T) {
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.2.7", "")
	if rep.ReturnPathAllowed {
		t.Fatal("an isolated subnet has no path in either direction")
	}
}

func chainedReExportTopo(t *testing.T) (*topology.Topology, *graph.Graph) {
	t.Helper()
	tdoc := projectdoc.TopologyDoc{
		Devices: []projectdoc.DeviceDoc{
			{Name: "market", Kind: "router"},
			{Name: "dc", Kind: "router"},
			{Name: "office", Kind: "router"},
		},
		Links: []projectdoc.LinkDoc{
			{
				A:      projectdoc.EndpointDoc{Device: "market"},
				B:      projectdoc.EndpointDoc{Device: "dc"},
				Filter: &projectdoc.LinkFilterDoc{AExports: []string{"MARKET"}, BExports: []string{"DC"}},
			},
			{
				A:      projectdoc.EndpointDoc{Device: "office"},
				B:      projectdoc.EndpointDoc{Device: "dc"},
				Filter: &projectdoc.LinkFilterDoc{AExports: []string{"OFFICE"}, BExports: []string{"DC", "MARKET"}},
			},
		},
		Networks: []projectdoc.NetworkDoc{
			{Name: "MARKET", Subnets: []string{"market-net"}, Attach: []projectdoc.EndpointDoc{{Device: "market"}}},
			{Name: "DC", Subnets: []string{"dc-net"}, Attach: []projectdoc.EndpointDoc{{Device: "dc"}}},
			{Name: "OFFICE", Subnets: []string{"office-net"}, Attach: []projectdoc.EndpointDoc{{Device: "office"}}},
		},
	}
	sdoc := projectdoc.SubnetsDoc{
		Subnets: []projectdoc.SubnetDoc{
			{Name: "market-net", CIDR: "10.9.0.0/24"},
			{Name: "dc-net", CIDR: "10.9.1.0/24"},
			{Name: "office-net", CIDR: "10.9.2.0/24"},
		},
	}
	topo, err := tdoc.ToTopology()
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := sdoc.ToSubnets()
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

func switchFilterTopo(t *testing.T, withFilter bool) (*topology.Topology, *graph.Graph) {
	t.Helper()
	link := projectdoc.LinkDoc{
		A: projectdoc.EndpointDoc{Device: "sw-a"},
		B: projectdoc.EndpointDoc{Device: "sw-b"},
	}
	if withFilter {
		link.Filter = &projectdoc.LinkFilterDoc{AExports: []string{"NA"}, BExports: []string{"NB"}}
	}
	tdoc := projectdoc.TopologyDoc{
		Devices: []projectdoc.DeviceDoc{
			{Name: "ra", Kind: "router"},
			{Name: "rb", Kind: "router"},
			{Name: "rc", Kind: "router"},
			{Name: "sw-a", Kind: "switch"},
			{Name: "sw-b", Kind: "switch"},
		},
		Links: []projectdoc.LinkDoc{
			{A: projectdoc.EndpointDoc{Device: "ra"}, B: projectdoc.EndpointDoc{Device: "sw-a"}},
			{A: projectdoc.EndpointDoc{Device: "rb"}, B: projectdoc.EndpointDoc{Device: "sw-b"}},
			{A: projectdoc.EndpointDoc{Device: "rc"}, B: projectdoc.EndpointDoc{Device: "sw-b"}},
			link,
		},
		Networks: []projectdoc.NetworkDoc{
			{Name: "NA", Subnets: []string{"a"}, Attach: []projectdoc.EndpointDoc{{Device: "ra"}}},
			{Name: "NB", Subnets: []string{"b"}, Attach: []projectdoc.EndpointDoc{{Device: "rb"}}},
			{Name: "NC", Subnets: []string{"c"}, Attach: []projectdoc.EndpointDoc{{Device: "rc"}}},
		},
	}
	sdoc := projectdoc.SubnetsDoc{
		Subnets: []projectdoc.SubnetDoc{
			{Name: "a", CIDR: "10.20.0.0/24"},
			{Name: "b", CIDR: "10.20.1.0/24"},
			{Name: "c", CIDR: "10.20.2.0/24"},
		},
	}
	topo, err := tdoc.ToTopology()
	if err != nil {
		t.Fatalf("load topology: %v", err)
	}
	subs, err := sdoc.ToSubnets()
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

// office learned a route to MARKET because dc re-exports it (b-exports on
// the office-dc link includes MARKET); market never learned a route back
// to OFFICE (b-exports on the market-dc link only has DC). This mirrors
// the real-world scenario the diagnose UI is meant to surface: the request
// physically arrives, the response has no route home — a routing gap, not
// a firewall verdict, but ReturnPathAllowed reports the same false either
// way (see internal/diagnose/diagnose.go's pathResults/returnPathAllowed).
func TestRun_ChainedReExportRequestArrivesReturnHasNoRoute(t *testing.T) {
	topo, g := chainedReExportTopo(t)
	rep, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.9.2.5"), Dst: netip.MustParseAddr("10.9.0.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run: %v", err)
	}
	if len(rep.Paths) == 0 {
		t.Fatal("office must have learned a route to market via dc's re-export")
	}
	if rep.ReturnPathAllowed {
		t.Fatal("market never learned a route back to office: no firewall rule can create a route that was never announced")
	}
}

// A filtered switch-switch link constrains route propagation across the
// trunk exactly like a filtered router-router link: b is announced across
// sw-a→sw-b (BExports) and stays reachable, c is not and becomes
// unreachable at the network layer — not because of any firewall verdict
// (sets is nil: every router allows unconditionally), a routing gap.
func TestRun_FilteredSwitchLinkConstrainsPropagation(t *testing.T) {
	topo, g := switchFilterTopo(t, true)

	repAB, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.1.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->b: %v", err)
	}
	if len(repAB.Paths) == 0 {
		t.Fatal("a->b: expected a path, b is announced across the sw-a/sw-b trunk")
	}
	if !repAB.ReturnPathAllowed {
		t.Fatal("a->b: return route must exist, a is announced back across the same trunk")
	}

	repAC, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.2.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->c: %v", err)
	}
	if len(repAC.Paths) != 0 {
		t.Fatalf("a->c: expected no path, c was never announced across the sw-a/sw-b trunk, got %+v", repAC.Paths)
	}
	// The return direction is NOT the mirror of the blocked forward path:
	// dst=a is announced via aExports regardless of which router on
	// sw-b's domain sends it (source is never checked — route-filtering
	// is destination-oriented, see internal/graph), so c can still reach
	// a even though nothing can reach c. With sets=nil (no firewall rules,
	// every router allows unconditionally), ReturnPathAllowed reduces to
	// exactly this network-layer question, the same way
	// TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink
	// demonstrates it at the router-router level.
	if !repAC.ReturnPathAllowed {
		t.Fatal("a->c: c can still reach a via aExports regardless of source, so the return route does exist at the network layer")
	}
}

// Regression guard for the original bug report: an *unfiltered* switch
// link still merges both switches into one L2 domain, so c (behind rc, on
// sw-b like b) stays reachable from a in a single path. Nothing in Tasks
// 1-4 should have changed this.
func TestRun_PlainSwitchLinkStillMergesDomain(t *testing.T) {
	topo, g := switchFilterTopo(t, false)
	rep, err := diagnose.Run(topo, nil, g, graph.DefaultLimits(), diagnose.Flow{
		Src: netip.MustParseAddr("10.20.0.5"), Dst: netip.MustParseAddr("10.20.2.5"), Proto: rules.ProtoAny,
	})
	if err != nil {
		t.Fatalf("diagnose.Run a->c: %v", err)
	}
	if len(rep.Paths) != 1 {
		t.Fatalf("a->c: expected exactly 1 path through the merged sw-a+sw-b domain, got %+v", rep.Paths)
	}
}
