package topology

import (
	"net/netip"
	"testing"
)

func mustPrefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse prefix %q: %v", s, err)
	}
	return p
}

func baseTopology(t *testing.T) *Topology {
	t.Helper()
	return &Topology{
		Devices: map[string]Device{
			"r1": {Name: "r1", Kind: DeviceRouter, Interfaces: []string{"wan0", "lan0"}},
			"r2": {Name: "r2", Kind: DeviceRouter, Interfaces: []string{"wan0", "lan0"}},
		},
		Links: []Link{
			{A: InterfaceRef{"r1", "wan0"}, B: InterfaceRef{"r2", "wan0"}},
		},
		Subnets: map[string]Subnet{
			"a": {Name: "a", CIDR: mustPrefix(t, "10.0.0.0/24"), AttachedTo: []InterfaceRef{{"r1", "lan0"}}},
			"b": {Name: "b", CIDR: mustPrefix(t, "10.0.1.0/24"), AttachedTo: []InterfaceRef{{"r2", "lan0"}}},
		},
		Zones: map[string]Zone{},
	}
}

func TestValidate_OK(t *testing.T) {
	topo := baseTopology(t)
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_DuplicateInterface(t *testing.T) {
	topo := baseTopology(t)
	topo.Devices["r1"] = Device{Name: "r1", Kind: DeviceRouter, Interfaces: []string{"wan0", "wan0"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for duplicate interface")
	}
}

func TestValidate_DanglingLinkReference(t *testing.T) {
	topo := baseTopology(t)
	topo.Links = append(topo.Links, Link{A: InterfaceRef{"r1", "nope"}, B: InterfaceRef{"r2", "lan0"}})
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown interface")
	}
}

func TestValidate_InterfaceUsedTwice(t *testing.T) {
	topo := baseTopology(t)
	// r1.lan0 is already used by subnet "a"; reusing it in a link must fail.
	topo.Links = append(topo.Links, Link{A: InterfaceRef{"r1", "lan0"}, B: InterfaceRef{"r2", "lan0"}})
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for interface used twice")
	}
}

func TestValidate_SelfLoopLink(t *testing.T) {
	topo := baseTopology(t)
	topo.Links[0] = Link{A: InterfaceRef{"r1", "wan0"}, B: InterfaceRef{"r1", "lan0"}}
	// lan0 also used by subnet a -> would double-claim, but self-loop check fires first.
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for self-loop link")
	}
}

func TestValidate_OverlappingSubnets(t *testing.T) {
	topo := baseTopology(t)
	topo.Subnets["b"] = Subnet{Name: "b", CIDR: mustPrefix(t, "10.0.0.128/25"), AttachedTo: []InterfaceRef{{"r2", "lan0"}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for overlapping subnets")
	}
}

func TestValidate_ZoneCycle(t *testing.T) {
	topo := baseTopology(t)
	topo.Zones["x"] = Zone{Name: "x", Zones: []string{"y"}}
	topo.Zones["y"] = Zone{Name: "y", Zones: []string{"x"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for zone cycle")
	}
}

func TestValidate_ZoneUnknownSubnet(t *testing.T) {
	topo := baseTopology(t)
	topo.Zones["x"] = Zone{Name: "x", Subnets: []string{"nope"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown subnet in zone")
	}
}

func TestResolveZone_NestedUnion(t *testing.T) {
	topo := baseTopology(t)
	topo.Zones["dmz-web"] = Zone{Name: "dmz-web", Subnets: []string{"a"}}
	topo.Zones["dmz-db"] = Zone{Name: "dmz-db", Subnets: []string{"b"}}
	topo.Zones["dmz"] = Zone{Name: "dmz", Zones: []string{"dmz-web", "dmz-db"}}

	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, err := topo.ResolveZone("dmz")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	want := []string{"a", "b"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("ResolveZone(dmz) = %v, want %v", got, want)
	}
}

func TestResolveZone_BareSubnet(t *testing.T) {
	topo := baseTopology(t)
	got, err := topo.ResolveZone("a")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("ResolveZone(a) = %v, want [a]", got)
	}
}
