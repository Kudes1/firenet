package app

import (
	"net/netip"
	"slices"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

func dev(name string) topology.Device {
	return topology.Device{Name: name, Kind: topology.DeviceRouter}
}

func sub(name, cidr string) topology.Subnet {
	return topology.Subnet{Name: name, CIDR: netip.MustParsePrefix(cidr)}
}

func rule(name string, src, dst []string) rules.Rule {
	return rules.Rule{Name: name, Src: src, Dst: dst, Proto: rules.ProtoAny, Action: rules.ActionAllow}
}

func TestDeletionErrors_SubnetUsedByNetworkSetAndRule(t *testing.T) {
	prev := &topology.Topology{
		Subnets: map[string]topology.Subnet{"dmz": sub("dmz", "10.0.1.0/24")},
	}
	next := &topology.Topology{
		Networks: map[string]topology.Network{"n-dmz": {Name: "n-dmz", Subnets: []string{"dmz"}}},
		Sets:     map[string]topology.Set{"s-web": {Name: "s-web", Subnets: []string{"dmz"}}},
	}
	pol := &rules.Policy{Chains: []rules.Chain{{Rules: []rules.Rule{rule("office-to-dmz", []string{"office"}, []string{"dmz"})}}}}

	errs := DeletionErrors(prev, next, pol)
	want := `subnet "dmz" is still used by network "n-dmz", set "s-web", rule "office-to-dmz"`
	if len(errs) != 1 || errs[0] != want {
		t.Fatalf("errs = %#v, want [%s]", errs, want)
	}
}

func TestDeletionErrors_UnusedSubnetDeletable(t *testing.T) {
	prev := &topology.Topology{
		Subnets: map[string]topology.Subnet{
			"guest": sub("guest", "10.0.2.0/24"),
			"dmz":   sub("dmz", "10.0.1.0/24"),
		},
		Networks: map[string]topology.Network{"n-dmz": {Name: "n-dmz", Subnets: []string{"dmz"}}},
	}
	next := &topology.Topology{
		Subnets:  map[string]topology.Subnet{"dmz": sub("dmz", "10.0.1.0/24")},
		Networks: prev.Networks,
	}
	if errs := DeletionErrors(prev, next, nil); len(errs) != 0 {
		t.Fatalf("errs = %#v, want none", errs)
	}
}

func TestDeletionErrors_NetworkAndSetUsedByRule(t *testing.T) {
	prev := &topology.Topology{
		Networks: map[string]topology.Network{"n-office": {Name: "n-office"}},
		Sets:     map[string]topology.Set{"s-web": {Name: "s-web"}},
	}
	next := &topology.Topology{}
	pol := &rules.Policy{Chains: []rules.Chain{{Rules: []rules.Rule{rule("web-allow", []string{"n-office"}, []string{"s-web"})}}}}

	errs := DeletionErrors(prev, next, pol)
	slices.Sort(errs)
	want := []string{
		`network "n-office" is still used by rule "web-allow"`,
		`set "s-web" is still used by rule "web-allow"`,
	}
	if !slices.Equal(errs, want) {
		t.Fatalf("errs = %#v, want %v", errs, want)
	}
}

func TestDeletionErrors_DeviceUsedByLinkOrAttach(t *testing.T) {
	prev := &topology.Topology{
		Devices: map[string]topology.Device{"r1": dev("r1"), "r2": dev("r2"), "sw": dev("sw")},
	}
	next := &topology.Topology{
		Devices:  map[string]topology.Device{"sw": dev("sw")},
		Links:    []topology.Link{{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw"}}},
		Networks: map[string]topology.Network{"lan": {Name: "lan", Attach: []topology.Endpoint{{Device: "r2"}}}},
	}
	errs := DeletionErrors(prev, next, nil)
	if len(errs) != 2 {
		t.Fatalf("errs = %#v, want two device errors", errs)
	}
	for _, want := range []string{
		`device "r1" is still used by link[0]`,
		`device "r2" is still used by network "lan"`,
	} {
		if !slices.Contains(errs, want) {
			t.Fatalf("errs = %#v, want containing %q", errs, want)
		}
	}
}

func TestDeletionErrors_FreeDeviceDeletable(t *testing.T) {
	prev := &topology.Topology{Devices: map[string]topology.Device{"sw": dev("sw")}}
	next := &topology.Topology{}
	if errs := DeletionErrors(prev, next, nil); len(errs) != 0 {
		t.Fatalf("errs = %#v, want none", errs)
	}
}

func TestDeletionErrors_NoDeletionsNoErrors(t *testing.T) {
	prev := &topology.Topology{
		Devices: map[string]topology.Device{"r1": dev("r1")},
		Subnets: map[string]topology.Subnet{"dmz": sub("dmz", "10.0.1.0/24")},
	}
	if errs := DeletionErrors(prev, prev, nil); len(errs) != 0 {
		t.Fatalf("errs = %#v, want none", errs)
	}
}

func TestDeletionErrors_NilPolicySkipsRuleChecks(t *testing.T) {
	prev := &topology.Topology{Networks: map[string]topology.Network{"n": {Name: "n"}}}
	if errs := DeletionErrors(prev, &topology.Topology{}, nil); len(errs) != 0 {
		t.Fatalf("errs = %#v, want none (no policy loaded)", errs)
	}
}

func TestDeletionErrors_DeviceUsedByUnion(t *testing.T) {
	prev := &topology.Topology{
		Devices: map[string]topology.Device{"r1": dev("r1"), "r2": dev("r2")},
		Unions:  map[string]topology.Union{"office": {Name: "office", Devices: []string{"r1"}}},
	}
	next := &topology.Topology{
		Devices: map[string]topology.Device{"r2": dev("r2")},
		Unions:  prev.Unions,
	}
	errs := DeletionErrors(prev, next, nil)
	want := `device "r1" is still used by union "office"`
	if len(errs) != 1 || errs[0] != want {
		t.Fatalf("errs = %#v, want [%s]", errs, want)
	}
}

func TestDeletionErrors_NetworkUsedByUnion(t *testing.T) {
	prev := &topology.Topology{
		Networks: map[string]topology.Network{"n-lan": {Name: "n-lan"}},
		Unions:   map[string]topology.Union{"office": {Name: "office", Networks: []string{"n-lan"}}},
	}
	next := &topology.Topology{Unions: prev.Unions}
	errs := DeletionErrors(prev, next, nil)
	want := `network "n-lan" is still used by union "office"`
	if len(errs) != 1 || errs[0] != want {
		t.Fatalf("errs = %#v, want [%s]", errs, want)
	}
}

func TestDeletionErrors_UnionRemovedWithMember(t *testing.T) {
	prev := &topology.Topology{
		Devices: map[string]topology.Device{"r1": dev("r1")},
		Unions:  map[string]topology.Union{"office": {Name: "office", Devices: []string{"r1"}}},
	}
	next := &topology.Topology{}
	if errs := DeletionErrors(prev, next, nil); len(errs) != 0 {
		t.Fatalf("errs = %#v, want none (union deleted along with its member)", errs)
	}
}
