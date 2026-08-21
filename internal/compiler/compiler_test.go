package compiler

import (
	"net/netip"
	"testing"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

func prefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse prefix %q: %v", s, err)
	}
	return p
}

// redundantTopology has subnets A and B each dual-homed to r1 and r2, plus a
// third, unrelated router r3 that no rule should ever touch.
func redundantTopology(t *testing.T) *topology.Topology {
	t.Helper()
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
			"r3": {Name: "r3", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
			"C": {Name: "C", CIDR: prefix(t, "10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"ab": {Name: "ab", Subnets: []string{"A", "B"}, Attach: []topology.Endpoint{
				{Device: "r1", Interface: "ab0"}, {Device: "r2", Interface: "ab0"},
			}},
			"nC": {Name: "nC", Subnets: []string{"C"}, Attach: []topology.Endpoint{
				{Device: "r3", Interface: "c0"},
			}},
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	return topo
}

func deviceOf(t *testing.T, ds []DeviceRuleset, name string) DeviceRuleset {
	t.Helper()
	for _, d := range ds {
		if d.Device == name {
			return d
		}
	}
	t.Fatalf("no ruleset for device %q", name)
	return DeviceRuleset{}
}

func requireNoDevice(t *testing.T, ds []DeviceRuleset, name string) {
	t.Helper()
	for _, d := range ds {
		if d.Device == name {
			t.Fatalf("%s: got a ruleset (%d rules), want none — a router with no rules should be omitted entirely", name, len(d.Rules))
		}
	}
}

func TestCompile_PlacesOnBothRedundantRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "a-to-b-https", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	for _, name := range []string{"r1", "r2"} {
		d := deviceOf(t, out, name)
		if len(d.Rules) != 1 {
			t.Fatalf("%s: got %d rules, want 1", name, len(d.Rules))
		}
		if d.Rules[0].SrcSet == "" || d.Rules[0].DstSet == "" {
			t.Fatalf("%s: expected both src and dst ipset matches, got %+v", name, d.Rules[0])
		}
	}

	// r3 is unrelated to A/B traffic and must not receive a ruleset at all.
	requireNoDevice(t, out, "r3")
}

func TestCompile_NetworkExpandsToMembers(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "c-to-ab", Src: []string{"C"}, Dst: []string{"ab"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	// C has no path to A or B in this fixture (r3 is isolated), so the rule
	// resolves to zero placements and no device gets a ruleset at all.
	if len(out) != 0 {
		t.Fatalf("got %d devices, want 0 (C is unreachable from ab)", len(out))
	}
}

func TestCompile_AnyAnyPlacesOnAllRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "allow-icmp", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoICMP, Action: rules.ActionAllow},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, name := range []string{"r1", "r2", "r3"} {
		d := deviceOf(t, out, name)
		if len(d.Rules) != 1 {
			t.Fatalf("%s: got %d rules, want 1 (any-any must reach every router)", name, len(d.Rules))
		}
		if d.Rules[0].SrcSet != "" || d.Rules[0].DstSet != "" {
			t.Fatalf("%s: any-any rule must be unconditional, got %+v", name, d.Rules[0])
		}
	}
}

func TestCompile_DedupIdenticalRules(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "rule-one", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
			{Name: "rule-two", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	if len(d.Rules) != 1 {
		t.Fatalf("got %d rules, want 1 after dedup", len(d.Rules))
	}
}

func TestCompile_CommentPrefersCommentOverName(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "named", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
			{Name: "described", Comment: "доступ к БД", Src: []string{"B"}, Dst: []string{"A"}, Proto: rules.ProtoTCP, DstPorts: []string{"5432"}, Action: rules.ActionDeny},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	var named, described *CompiledRule
	for i := range d.Rules {
		switch d.Rules[i].Comment {
		case "named":
			named = &d.Rules[i]
		case "доступ к БД":
			described = &d.Rules[i]
		}
	}
	if named == nil {
		t.Fatalf("rule without comment must fall back to its name in --comment")
	}
	if described == nil {
		t.Fatalf("rule comment must reach CompiledRule.Comment, got rules: %+v", d.Rules)
	}
}

func TestCompile_MirrorExpandsReverseDirection(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "ab-tcp", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow, Mirror: true},
		},
	}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	if len(d.Rules) != 2 {
		t.Fatalf("got %d rules, want 2 (original + mirrored)", len(d.Rules))
	}
	forward, reverse := d.Rules[0], d.Rules[1]
	if forward.SrcSet != ipsetName("A") || forward.DstSet != ipsetName("B") {
		t.Fatalf("unexpected forward rule: %+v", forward)
	}
	if reverse.SrcSet != ipsetName("B") || reverse.DstSet != ipsetName("A") {
		t.Fatalf("unexpected reverse rule: %+v", reverse)
	}
	if len(forward.SrcPorts) != 0 || len(forward.DstPorts) != 1 || forward.DstPorts[0] != "443" {
		t.Fatalf("unexpected forward ports: %+v", forward)
	}
	if len(reverse.DstPorts) != 0 || len(reverse.SrcPorts) != 1 || reverse.SrcPorts[0] != "443" {
		t.Fatalf("mirrored rule must swap ports (dst port becomes src port on reverse), got: %+v", reverse)
	}
	if len(pol.Rules) != 1 {
		t.Fatalf("mirroring must not mutate the source policy, got %d rules", len(pol.Rules))
	}
}
