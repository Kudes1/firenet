package graph

import (
	"net/netip"
	"testing"

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

func routers(paths []Path) map[string]bool {
	out := map[string]bool{}
	for _, r := range RoutersOnPaths(paths) {
		out[r] = true
	}
	return out
}

// netWithSubnets builds a Network named name whose subnets are all attached
// to the given endpoints.
func netWithSubnets(name string, subnets []string, eps ...topology.Endpoint) topology.Network {
	return topology.Network{Name: name, Subnets: subnets, Attach: eps}
}

func TestBuild_LinearChain(t *testing.T) {
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "r2"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "r1"}),
			"nB": netWithSubnets("nB", []string{"B"}, topology.Endpoint{Device: "r2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("A"), SubnetNode("B"), DefaultLimits())
	if err != nil {
		t.Fatalf("pathfind: %v", err)
	}
	if len(paths) != 1 {
		t.Fatalf("got %d paths, want 1", len(paths))
	}
	rs := routers(paths)
	if !rs["r1"] || !rs["r2"] || len(rs) != 2 {
		t.Fatalf("routers = %v, want {r1, r2}", rs)
	}
}

func TestBuild_RedundantPaths(t *testing.T) {
	// Networks nA and nB are each dual-homed to r1 and r2 directly (HA
	// gateways), with no link between r1 and r2 themselves -- exactly two
	// independent transit paths between their subnets.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"},
				topology.Endpoint{Device: "r1"}, topology.Endpoint{Device: "r2"}),
			"nB": netWithSubnets("nB", []string{"B"},
				topology.Endpoint{Device: "r1"}, topology.Endpoint{Device: "r2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("A"), SubnetNode("B"), DefaultLimits())
	if err != nil {
		t.Fatalf("pathfind: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("got %d paths, want 2", len(paths))
	}
	rs := routers(paths)
	if !rs["r1"] || !rs["r2"] || len(rs) != 2 {
		t.Fatalf("routers = %v, want {r1, r2}", rs)
	}
}

func TestBuild_SwitchChainCollapses(t *testing.T) {
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"}},
		},
		Subnets: map[string]topology.Subnet{
			"X": {Name: "X", CIDR: prefix(t, "10.0.0.0/24")},
			"A": {Name: "A", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nX": netWithSubnets("nX", []string{"X"}, topology.Endpoint{Device: "r1"}),
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "sw2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("X"), SubnetNode("A"), DefaultLimits())
	if err != nil {
		t.Fatalf("pathfind: %v", err)
	}
	if len(paths) != 1 || len(paths[0].Routers()) != 1 || paths[0].Routers()[0] != "r1" {
		t.Fatalf("paths = %+v, want a single path through r1", paths)
	}
}

func TestBuild_AllSubnetsOfNetworkShareSegment(t *testing.T) {
	// Both subnets of one network hang off the same router: they must be
	// mutually reachable in one hop through no other device.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "r2"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"n": netWithSubnets("n", []string{"A", "B"}, topology.Endpoint{Device: "r1"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("A"), SubnetNode("B"), DefaultLimits())
	if err != nil {
		t.Fatalf("pathfind: %v", err)
	}
	if len(paths) != 1 || paths[0].Nodes[1] != RouterNode("r1") {
		t.Fatalf("paths = %+v, want a single path A-r1-B", paths)
	}
}

func TestAllSimplePaths_CycleDoesNotHang(t *testing.T) {
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
			"r3": {Name: "r3", Kind: topology.DeviceRouter},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "r2"}},
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "r3"}},
			{A: topology.Endpoint{Device: "r2"}, B: topology.Endpoint{Device: "r3"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "r1"}),
			"nB": netWithSubnets("nB", []string{"B"}, topology.Endpoint{Device: "r2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("A"), SubnetNode("B"), DefaultLimits())
	if err != nil {
		t.Fatalf("pathfind: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("expected at least one path")
	}
	rs := routers(paths)
	if !rs["r1"] || !rs["r2"] {
		t.Fatalf("routers = %v, want at least {r1, r2}", rs)
	}
}

func TestBuild_DomainNodeNamedAfterSwitch(t *testing.T) {
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"sw9": {Name: "sw9", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw9"}},
		},
		Subnets: map[string]topology.Subnet{
			"X": {Name: "X", CIDR: prefix(t, "10.0.0.0/24")},
			"A": {Name: "A", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nX": netWithSubnets("nX", []string{"X"}, topology.Endpoint{Device: "r1"}),
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "sw9"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("X"), SubnetNode("A"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("pathfind: %d paths (%v)", len(paths), err)
	}
	want := Node{Kind: NodeDomain, Name: "sw9"}
	found := false
	for _, n := range paths[0].Nodes {
		if n == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("path %v misses domain node %+v", paths[0].Nodes, want)
	}
}

func TestBuild_MultiSwitchDomainJoinedName(t *testing.T) {
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw2"}, B: topology.Endpoint{Device: "sw1"}},
		},
		Subnets: map[string]topology.Subnet{
			"X": {Name: "X", CIDR: prefix(t, "10.0.0.0/24")},
			"A": {Name: "A", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nX": netWithSubnets("nX", []string{"X"}, topology.Endpoint{Device: "r1"}),
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "sw1"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("X"), SubnetNode("A"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("pathfind: %d paths (%v)", len(paths), err)
	}
	want := Node{Kind: NodeDomain, Name: "sw1+sw2"}
	found := false
	for _, n := range paths[0].Nodes {
		if n == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("path %v misses domain node %+v", paths[0].Nodes, want)
	}
}

func filteredTopo() *topology.Topology {
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
			{A: topology.Endpoint{Device: "m"}, B: topology.Endpoint{Device: "d"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
			{A: topology.Endpoint{Device: "d"}, B: topology.Endpoint{Device: "o"}},
		},
	}
}

func TestBuild_FilteredLinkAllowsAnnouncedPairs(t *testing.T) {
	g, err := Build(filteredTopo())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) == 0 {
		t.Fatalf("a→b expected reachable, got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_FilteredLinkBlocksUnannouncedDst(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("c"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("a→c must be filtered out, got %d paths (%v)", len(paths), err)
	}
}

// c→a used to be blocked because 'c' never appeared in the m-d filter's
// own declared lists. Real routers don't work that way: 'd' legitimately
// learned a route to 'a' (via the m-d filter's AExports) and freely shares
// everything it knows with 'o' across their unrestricted link — exactly
// like an ordinary router redistributing its routing table. Restricting
// *who* may ride along a specific link, regardless of destination, is now
// a firewall/rule concern (internal/rules), not a routing one.
func TestBuild_FilteredLinkPropagatesLearnedRouteAcrossPlainLink(t *testing.T) {
	g, _ := Build(filteredTopo())
	paths, err := g.AllSimplePaths(SubnetNode("c"), SubnetNode("a"), DefaultLimits())
	if err != nil || len(paths) == 0 {
		t.Fatalf("c→a expected reachable: d relays its learned route to a across the plain d-o link, got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_PlainLinkStillUnrestricted(t *testing.T) {
	topo := filteredTopo()
	topo.Links[0].Filter = nil // та же топология без фильтра
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for _, pair := range [][2]string{{"a", "b"}, {"a", "c"}, {"c", "a"}} {
		paths, err := g.AllSimplePaths(SubnetNode(pair[0]), SubnetNode(pair[1]), DefaultLimits())
		if err != nil || len(paths) == 0 {
			t.Fatalf("%s→%s expected reachable without filter, got %d paths (%v)", pair[0], pair[1], len(paths), err)
		}
	}
}

func TestAllSimplePaths_TooManyPaths(t *testing.T) {
	devices := map[string]topology.Device{}
	var epsA, epsB []topology.Endpoint
	for i := 0; i < 4; i++ {
		name := "r" + string(rune('1'+i))
		devices[name] = topology.Device{Name: name, Kind: topology.DeviceRouter}
		epsA = append(epsA, topology.Endpoint{Device: name})
		epsB = append(epsB, topology.Endpoint{Device: name})
	}
	topo := &topology.Topology{
		Devices: devices,
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"}, epsA...),
			"nB": netWithSubnets("nB", []string{"B"}, epsB...),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	_, err = g.AllSimplePaths(SubnetNode("A"), SubnetNode("B"), Limits{MaxHops: 8, MaxPaths: 2})
	if err == nil {
		t.Fatal("expected ErrTooManyPaths")
	}
	if _, ok := err.(*ErrTooManyPaths); !ok {
		t.Fatalf("got error %v (%T), want *ErrTooManyPaths", err, err)
	}
}
