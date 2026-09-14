package lint

import (
	"net/netip"
	"reflect"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// testTopology is the shared fixture for every test in this package:
// subnets office (10.0.0.0/24) and dmz (10.0.1.0/24, adjacent to office),
// network "corp" grouping both, and set "blocked" combining a subnet
// with a host address.
func testTopology() *topology.Topology {
	return &topology.Topology{
		Subnets: map[string]topology.Subnet{
			"office": {Name: "office", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"dmz":    {Name: "dmz", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"corp": {Name: "corp", Subnets: []string{"office", "dmz"}},
		},
		Sets: map[string]topology.Set{
			"blocked": {
				Name:      "blocked",
				Subnets:   []string{"office"},
				Addresses: []netip.Prefix{netip.MustParsePrefix("192.168.1.9/32")},
			},
		},
	}
}

// addrUint32 mirrors prefixInterval's byte order for readable literals in
// test expectations — big-endian, i.e. the address's actual numeric value.
func addrUint32(s string) uint64 {
	b := netip.MustParseAddr(s).As4()
	return uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
}

func TestEndpointIntervals(t *testing.T) {
	topo := testTopology()
	tests := []struct {
		name string
		want []interval
	}{
		{rules.Any, []interval{anyIPInterval}},
		{"office", []interval{{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")}}},
		{"10.0.2.5", []interval{{lo: addrUint32("10.0.2.5"), hi: addrUint32("10.0.2.5")}}},
		{"10.0.2.0/24", []interval{{lo: addrUint32("10.0.2.0"), hi: addrUint32("10.0.2.255")}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := endpointIntervals(topo, tt.name)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("endpointIntervals(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestEndpointIntervals_NetworkAggregatesMembers(t *testing.T) {
	topo := testTopology()
	got := mergeIntervals(endpointIntervals(topo, "corp"))
	want := mergeIntervals([]interval{
		{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")},
		{lo: addrUint32("10.0.1.0"), hi: addrUint32("10.0.1.255")},
	})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("corp intervals = %v, want %v", got, want)
	}
}

func TestEndpointIntervals_SetCombinesSubnetsAndAddresses(t *testing.T) {
	topo := testTopology()
	got := mergeIntervals(endpointIntervals(topo, "blocked"))
	want := mergeIntervals([]interval{
		{lo: addrUint32("10.0.0.0"), hi: addrUint32("10.0.0.255")},
		{lo: addrUint32("192.168.1.9"), hi: addrUint32("192.168.1.9")},
	})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("blocked set intervals = %v, want %v", got, want)
	}
}

func TestEndpointIntervals_UnknownNameResolvesEmpty(t *testing.T) {
	topo := testTopology()
	if got := endpointIntervals(topo, "nonexistent"); got != nil {
		t.Fatalf("unknown name should resolve to nil, got %v", got)
	}
}

func TestPortIntervals(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []interval
	}{
		{"empty means any", nil, []interval{anyPortInterval}},
		{"single port", []string{"443"}, []interval{{443, 443}}},
		{"range", []string{"1000-2000"}, []interval{{1000, 2000}}},
		{"multiple specs", []string{"80", "443"}, []interval{{80, 80}, {443, 443}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := portIntervals(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("portIntervals(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
