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
			"a": {Name: "a", CIDR: mustPrefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: mustPrefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]Network{
			"n1": {Name: "n1", Subnets: []string{"a"}, Attach: []Endpoint{{Device: "r1", Interface: "lan0"}}},
			"n2": {Name: "n2", Subnets: []string{"b"}, Attach: []Endpoint{{Device: "r2", Interface: "lan0"}}},
		},
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
	topo.Subnets["b"] = Subnet{Name: "b", CIDR: mustPrefix(t, "10.0.0.128/25")}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for overlapping subnets")
	}
}

func TestValidate_NetworkUnknownSubnet(t *testing.T) {
	topo := baseTopology(t)
	topo.Networks["n1"] = Network{Name: "n1", Subnets: []string{"nope"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown subnet in network")
	}
}

func TestValidate_SubnetInTwoNetworks(t *testing.T) {
	topo := baseTopology(t)
	topo.Networks["n3"] = Network{Name: "n3", Subnets: []string{"a"}, Attach: []Endpoint{{Device: "r2"}}}
	err := topo.Validate()
	if err == nil {
		t.Fatal("expected error for subnet in two networks")
	}
}

func TestValidate_NetworkUnknownDevice(t *testing.T) {
	topo := baseTopology(t)
	topo.Networks["n1"] = Network{Name: "n1", Subnets: []string{"a"}, Attach: []Endpoint{{Device: "nope"}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown device in network attach")
	}
}

func TestResolveNetwork_FlattensToSubnets(t *testing.T) {
	topo := baseTopology(t)
	topo.Networks["n1"] = Network{Name: "n1", Subnets: []string{"b", "a"}}

	got, err := topo.ResolveNetwork("n1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	want := []string{"a", "b"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("ResolveNetwork(n1) = %v, want %v", got, want)
	}
}

func TestResolveNetwork_BareSubnet(t *testing.T) {
	topo := baseTopology(t)
	got, err := topo.ResolveNetwork("a")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("ResolveNetwork(a) = %v, want [a]", got)
	}
}

func TestResolveNetwork_UnknownName(t *testing.T) {
	topo := baseTopology(t)
	if _, err := topo.ResolveNetwork("nope"); err == nil {
		t.Fatal("expected error for unknown name")
	}
}
