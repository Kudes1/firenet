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
			"r1": {Name: "r1", Kind: topology.DeviceRouter, Interfaces: []string{"a0", "b0"}},
			"r2": {Name: "r2", Kind: topology.DeviceRouter, Interfaces: []string{"a0", "b0"}},
			"r3": {Name: "r3", Kind: topology.DeviceRouter, Interfaces: []string{"c0"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24"), AttachedTo: []topology.InterfaceRef{
				{Device: "r1", Interface: "a0"}, {Device: "r2", Interface: "a0"},
			}},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24"), AttachedTo: []topology.InterfaceRef{
				{Device: "r1", Interface: "b0"}, {Device: "r2", Interface: "b0"},
			}},
			"C": {Name: "C", CIDR: prefix(t, "10.0.2.0/24"), AttachedTo: []topology.InterfaceRef{
				{Device: "r3", Interface: "c0"},
			}},
		},
		Zones: map[string]topology.Zone{
			"ab": {Name: "ab", Subnets: []string{"A", "B"}},
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

func TestCompile_PlacesOnBothRedundantRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
		Rules: []rules.Rule{
			{Name: "a-to-b-https", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, Ports: []string{"443"}, Action: rules.ActionAllow},
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

	// r3 is unrelated to A/B traffic and must not receive the rule.
	r3 := deviceOf(t, out, "r3")
	if len(r3.Rules) != 0 {
		t.Fatalf("r3: got %d rules, want 0", len(r3.Rules))
	}
}

func TestCompile_ZoneExpandsToMembers(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
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
	// should resolve to zero placements without erroring.
	for _, name := range []string{"r1", "r2", "r3"} {
		d := deviceOf(t, out, name)
		if len(d.Rules) != 0 {
			t.Fatalf("%s: got %d rules, want 0 (C is unreachable from ab)", name, len(d.Rules))
		}
	}
}

func TestCompile_AnyAnyPlacesOnAllRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{
		DefaultAction: rules.ActionDeny,
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
		Rules: []rules.Rule{
			{Name: "rule-one", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, Ports: []string{"443"}, Action: rules.ActionAllow},
			{Name: "rule-two", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, Ports: []string{"443"}, Action: rules.ActionAllow},
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
