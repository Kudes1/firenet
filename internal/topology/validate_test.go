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
			"r1": {Name: "r1", Kind: DeviceRouter},
			"r2": {Name: "r2", Kind: DeviceRouter},
		},
		Links: []Link{
			{A: Endpoint{"r1", "wan0"}, B: Endpoint{"r2", "wan0"}},
		},
		Subnets: map[string]Subnet{
			"a": {Name: "a", CIDR: mustPrefix(t, "10.0.0.0/24"), AttachedTo: []Endpoint{{"r1", "lan0"}}},
			"b": {Name: "b", CIDR: mustPrefix(t, "10.0.1.0/24"), AttachedTo: []Endpoint{{"r2", "lan0"}}},
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

func TestValidate_InterfaceLabelUnconstrained(t *testing.T) {
	topo := baseTopology(t)
	// Interface labels are free-form annotations: duplicates, reuse across
	// links/attachments, and omitting them entirely are all fine.
	topo.Links = append(topo.Links, Link{A: Endpoint{Device: "r1", Interface: "lan0"}, B: Endpoint{Device: "r2"}})
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_DanglingLinkReference(t *testing.T) {
	topo := baseTopology(t)
	topo.Links = append(topo.Links, Link{A: Endpoint{Device: "nope"}, B: Endpoint{Device: "r2"}})
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown device")
	}
}

func TestValidate_SelfLoopLink(t *testing.T) {
	topo := baseTopology(t)
	topo.Links[0] = Link{A: Endpoint{Device: "r1"}, B: Endpoint{Device: "r1"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for self-loop link")
	}
}

func TestValidate_OverlappingSubnets(t *testing.T) {
	topo := baseTopology(t)
	topo.Subnets["b"] = Subnet{Name: "b", CIDR: mustPrefix(t, "10.0.0.128/25"), AttachedTo: []Endpoint{{"r2", "lan0"}}}
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
