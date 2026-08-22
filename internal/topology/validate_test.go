package topology

import (
	"net/netip"
	"strings"
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
			{A: Endpoint{"r1"}, B: Endpoint{"r2"}},
		},
		Subnets: map[string]Subnet{
			"a": {Name: "a", CIDR: mustPrefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: mustPrefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]Network{
			"n1": {Name: "n1", Subnets: []string{"a"}, Attach: []Endpoint{{Device: "r1"}}},
			"n2": {Name: "n2", Subnets: []string{"b"}, Attach: []Endpoint{{Device: "r2"}}},
		},
	}
}

func TestValidate_OK(t *testing.T) {
	topo := baseTopology(t)
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_DuplicateAttach(t *testing.T) {
	topo := baseTopology(t)
	n1 := topo.Networks["n1"]
	n1.Attach = append(n1.Attach, Endpoint{Device: "r1"})
	topo.Networks["n1"] = n1
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

func TestValidate_DuplicateLink(t *testing.T) {
	for _, dup := range []Link{
		{A: Endpoint{Device: "r1"}, B: Endpoint{Device: "r2"}}, // same order
		{A: Endpoint{Device: "r2"}, B: Endpoint{Device: "r1"}}, // reversed
	} {
		topo := baseTopology(t)
		topo.Links = append(topo.Links, dup)
		err := topo.Validate()
		if err == nil || !strings.Contains(err.Error(), "duplicate link") {
			t.Errorf("expected duplicate link error for %+v, got %v", dup, err)
		}
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

func mustHostPrefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	addr, err := netip.ParseAddr(s)
	if err != nil {
		t.Fatalf("parse addr %q: %v", s, err)
	}
	return netip.PrefixFrom(addr, addr.BitLen())
}

func TestValidate_SetOK(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{
		"s1": {Name: "s1", Subnets: []string{"a"}, Addresses: []netip.Prefix{mustHostPrefix(t, "10.0.1.5")}},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_SetNameCollidesWithSubnet(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"a": {Name: "a", Subnets: []string{"b"}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for set name colliding with subnet")
	}
}

func TestValidate_SetNameCollidesWithNetwork(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"n1": {Name: "n1", Subnets: []string{"a"}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for set name colliding with network")
	}
}

func TestValidate_SetUnknownSubnet(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"s1": {Name: "s1", Subnets: []string{"ghost"}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for unknown subnet in set")
	}
}

func TestValidate_SetAddressOutsideKnownSubnets(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"s1": {Name: "s1", Addresses: []netip.Prefix{mustHostPrefix(t, "192.168.5.5")}}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for address outside known subnets")
	}
}

func TestValidate_EmptySet(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{"s1": {Name: "s1"}}
	if err := topo.Validate(); err == nil {
		t.Fatal("expected error for empty set")
	}
}

func TestResolveNetwork_FlattensSetToContainingSubnets(t *testing.T) {
	topo := baseTopology(t)
	topo.Sets = map[string]Set{
		"s1": {Name: "s1", Subnets: []string{"a"}, Addresses: []netip.Prefix{
			mustHostPrefix(t, "10.0.1.5"),
			mustHostPrefix(t, "10.0.0.7"),
		}},
	}
	got, err := topo.ResolveNetwork("s1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	want := []string{"a", "b"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("ResolveNetwork(s1) = %v, want %v", got, want)
	}
}

func TestResolveNetwork_UnknownName(t *testing.T) {
	topo := baseTopology(t)
	if _, err := topo.ResolveNetwork("nope"); err == nil {
		t.Fatal("expected error for unknown name")
	}
}

func TestValidate_Sites(t *testing.T) {
	base := func() *Topology {
		return &Topology{
			Devices:  map[string]Device{"r1": {Name: "r1", Kind: DeviceRouter}},
			Subnets:  map[string]Subnet{},
			Networks: map[string]Network{"net1": {Name: "net1"}},
			Sets:     map[string]Set{},
			Sites: map[string]Site{"office": {
				Name: "office", Devices: []string{"r1"}, Networks: []string{"net1"},
			}},
		}
	}
	if err := base().Validate(); err != nil {
		t.Fatalf("valid sites rejected: %v", err)
	}

	badRef := base()
	badRef.Sites["office"] = Site{Name: "office", Devices: []string{"ghost"}}
	if err := badRef.Validate(); err == nil || !strings.Contains(err.Error(), `unknown device "ghost"`) {
		t.Fatalf("want unknown device error, got %v", err)
	}

	double := base()
	double.Sites["zavod"] = Site{Name: "zavod", Devices: []string{"r1"}}
	err := double.Validate()
	if err == nil || !strings.Contains(err.Error(), `both site "office" and "zavod"`) {
		t.Fatalf("want double membership error, got %v", err)
	}

	badNet := base()
	badNet.Sites["office"] = Site{Name: "office", Networks: []string{"ghost"}}
	if err := badNet.Validate(); err == nil || !strings.Contains(err.Error(), `unknown network "ghost"`) {
		t.Fatalf("want unknown network error, got %v", err)
	}
}
