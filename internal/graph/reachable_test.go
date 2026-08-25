package graph

import (
	"net/netip"
	"reflect"
	"testing"

	"github.com/kudes1/firenet/internal/topology"
)

// chainTopo builds m - d - o: each router owns one network with one subnet,
// and both links are plain.
func chainTopo() *topology.Topology {
	return &topology.Topology{
		Devices: map[string]topology.Device{
			"m": {Name: "m", Kind: topology.DeviceRouter},
			"d": {Name: "d", Kind: topology.DeviceRouter},
			"o": {Name: "o", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"b": {Name: "b", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
			"c": {Name: "c", CIDR: netip.MustParsePrefix("10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": {Name: "NA", Subnets: []string{"a"}, Attach: []topology.Endpoint{{Device: "m"}}},
			"NB": {Name: "NB", Subnets: []string{"b"}, Attach: []topology.Endpoint{{Device: "d"}}},
			"NC": {Name: "NC", Subnets: []string{"c"}, Attach: []topology.Endpoint{{Device: "o"}}},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "m"}, B: topology.Endpoint{Device: "d"}},
			{A: topology.Endpoint{Device: "d"}, B: topology.Endpoint{Device: "o"}},
		},
	}
}

func filter(l *topology.Link, a, b []string) *topology.Link {
	l.Filter = &topology.LinkFilter{AExports: a, BExports: b}
	return l
}

func TestReachableEntities_PlainLinksReachEverything(t *testing.T) {
	topo := chainTopo()
	got, err := ReachableEntities(topo, "m", -1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "NB", "NC", "a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReachableEntities_SkipsGivenLink(t *testing.T) {
	topo := chainTopo()
	got, err := ReachableEntities(topo, "m", 0) // link m-d removed
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReachableEntities_FilteredLinkLimitsToExports(t *testing.T) {
	topo := chainTopo()
	filter(&topo.Links[0], []string{"NB"}, []string{"NA"})
	got, err := ReachableEntities(topo, "m", 0) // own link excluded
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("side m: got %v, want %v", got, want)
	}

	got, err = ReachableEntities(topo, "d", 0)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want = []string{"NB", "NC", "b", "c"} // d still reaches o via its plain link
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("side d: got %v, want %v", got, want)
	}
}

func TestReachableEntities_ChainsThroughOtherFilteredLinks(t *testing.T) {
	topo := chainTopo()
	// m announces NA toward d and d passes NA further to o while
	// announcing NC back up the chain: from m everything is in reach.
	filter(&topo.Links[0], []string{"NA"}, []string{"NB", "NC"})
	filter(&topo.Links[1], []string{"NA"}, []string{"NC"})
	got, err := ReachableEntities(topo, "m", -1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"NA", "NB", "NC", "a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	// d stops announcing anything toward o: from m, c becomes unreachable.
	filter(&topo.Links[1], []string{}, []string{"NC"})
	got, err = ReachableEntities(topo, "m", -1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want = []string{"NA", "NB", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReachableEntities_DeviceBehindSwitchOwnsItsNetwork(t *testing.T) {
	// market-a reaches its only network through a switch, not directly:
	// its own network must still count as a reachable export candidate.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"market-a": {Name: "market-a", Kind: topology.DeviceRouter},
			"sw":       {Name: "sw", Kind: topology.DeviceSwitch},
			"t1":       {Name: "t1", Kind: topology.DeviceRouter},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "market-a"}, B: topology.Endpoint{Device: "sw"}},
			*filter(&topology.Link{A: topology.Endpoint{Device: "market-a"}, B: topology.Endpoint{Device: "t1"}}, []string{"market-a-net"}, []string{"MAIN"}),
		},
		Subnets: map[string]topology.Subnet{
			"a":    {Name: "a", CIDR: netip.MustParsePrefix("10.0.0.0/24")},
			"main": {Name: "main", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"market-a-net": {Name: "market-a-net", Subnets: []string{"a"}, Attach: []topology.Endpoint{{Device: "sw"}}},
			"MAIN":         {Name: "MAIN", Subnets: []string{"main"}, Attach: []topology.Endpoint{{Device: "t1"}}},
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	got, err := ReachableEntities(topo, "market-a", 1)
	if err != nil {
		t.Fatalf("reachable: %v", err)
	}
	want := []string{"market-a-net", "a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if err := ValidateFilterExports(topo); err != nil {
		t.Fatalf("own-network export rejected: %v", err)
	}
}

func TestValidateFilterExports(t *testing.T) {
	topo := chainTopo()
	filter(&topo.Links[0], []string{"NA"}, []string{"NB"})
	if err := ValidateFilterExports(topo); err != nil {
		t.Fatalf("valid exports rejected: %v", err)
	}

	filter(&topo.Links[0], []string{"NC"}, []string{"NB"}) // c hangs behind o's filtered hop
	err := ValidateFilterExports(topo)
	if err == nil {
		t.Fatal("unreachable export accepted")
	}
	want := `link[0]: export "NC" is not reachable from router "m" (side A)`
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}

	// Learned-through-another-link exports stay valid: d reaches NA over
	// its plain link to m even though link d-o is skipped here.
	topo2 := chainTopo()
	filter(&topo2.Links[1], []string{"NA"}, []string{})
	if err := ValidateFilterExports(topo2); err != nil {
		t.Fatalf("plain-link exports rejected: %v", err)
	}
}
