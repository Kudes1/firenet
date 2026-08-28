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

// filteredSwitchTopo mirrors filteredTopo (below) but the filter sits on a
// switch-switch link instead of a router-router one: m is behind sw1; d
// and o are both behind sw2, so sw2's domain already has >=2 local attach
// points on its own (m's sw1 domain has only 1 — that side exercises the
// "domain gets a bus even with <2 points" exception).
func filteredSwitchTopo(t *testing.T) *topology.Topology {
	return &topology.Topology{
		Devices: map[string]topology.Device{
			"m":   {Name: "m", Kind: topology.DeviceRouter},
			"d":   {Name: "d", Kind: topology.DeviceRouter},
			"o":   {Name: "o", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: prefix(t, "10.0.1.0/24")},
			"c": {Name: "c", CIDR: prefix(t, "10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "m"}),
			"NB": netWithSubnets("NB", []string{"b"}, topology.Endpoint{Device: "d"}),
			"NC": netWithSubnets("NC", []string{"c"}, topology.Endpoint{Device: "o"}),
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "m"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "d"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "o"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		},
	}
}

func TestBuild_FilteredSwitchLinkSplitsDomains(t *testing.T) {
	topo := filteredSwitchTopo(t)
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("a->b: got %d paths (%v), want 1 (b is announced by sw2's side of the filter)", len(paths), err)
	}
	foundSw1, foundSw2 := false, false
	for _, n := range paths[0].Nodes {
		if n == (Node{Kind: NodeDomain, Name: "sw1"}) {
			foundSw1 = true
		}
		if n == (Node{Kind: NodeDomain, Name: "sw2"}) {
			foundSw2 = true
		}
	}
	if !foundSw1 || !foundSw2 {
		t.Fatalf("path %+v must cross sw1 and sw2 as two separate domains, not a merged sw1+sw2", paths[0].Nodes)
	}
}

func TestBuild_FilteredSwitchLinkBlocksUnannouncedDst(t *testing.T) {
	topo := filteredSwitchTopo(t)
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("c"), DefaultLimits())
	if err != nil || len(paths) != 0 {
		t.Fatalf("a->c must be filtered out (c is not in the sw1-sw2 filter's BExports), got %d paths (%v)", len(paths), err)
	}
}

func TestBuild_FilteredSwitchLinkNoOpWhenAlreadyMerged(t *testing.T) {
	// sw1 and sw2 are also joined via sw3 through plain links, so the
	// filtered sw1-sw2 link connects two switches that are already in the
	// same domain: it must contribute no extra edge, and definitely not a
	// second, phantom domain.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"r2":  {Name: "r2", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
			"sw2": {Name: "sw2", Kind: topology.DeviceSwitch},
			"sw3": {Name: "sw3", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
			{A: topology.Endpoint{Device: "r2"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw3"}},
			{A: topology.Endpoint{Device: "sw3"}, B: topology.Endpoint{Device: "sw2"}},
			{A: topology.Endpoint{Device: "sw1"}, B: topology.Endpoint{Device: "sw2"},
				Filter: &topology.LinkFilter{AExports: []string{"NA"}, BExports: []string{"NB"}}},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
			"b": {Name: "b", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "r1"}),
			"NB": netWithSubnets("NB", []string{"b"}, topology.Endpoint{Device: "r2"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	paths, err := g.AllSimplePaths(SubnetNode("a"), SubnetNode("b"), DefaultLimits())
	if err != nil || len(paths) != 1 {
		t.Fatalf("sw1 and sw2 are already merged via sw3: got %d paths (%v), want exactly 1 through one merged domain", len(paths), err)
	}
	want := Node{Kind: NodeDomain, Name: "sw1+sw2+sw3"}
	found := false
	for _, n := range paths[0].Nodes {
		if n == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("path %+v must cross the single merged domain %+v; the filtered sw1-sw2 link must not fork off a second one", paths[0].Nodes, want)
	}
}

func TestBuild_LonelySwitchStaysUnwiredWithoutFilteredLink(t *testing.T) {
	// Regression guard: a switch with exactly one local attach point and
	// no filtered link of its own still gets no bus node — the new "keep
	// the bus even with <2 points" exception must not fire here.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1":  {Name: "r1", Kind: topology.DeviceRouter},
			"sw1": {Name: "sw1", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1"}, B: topology.Endpoint{Device: "sw1"}},
		},
		Subnets: map[string]topology.Subnet{
			"a": {Name: "a", CIDR: prefix(t, "10.0.0.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA": netWithSubnets("NA", []string{"a"}, topology.Endpoint{Device: "r1"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// r1 legitimately has one edge of its own (to subnet "a", from its
	// direct network attachment) regardless of the switch link — that
	// edge is not what this test is about. What must NOT happen is r1
	// getting wired to sw1's bus, and the bus itself must not exist.
	bus := Node{Kind: NodeDomain, Name: "sw1"}
	if len(g.adj[bus]) != 0 {
		t.Fatalf("a lone switch with one attach point and no filtered link must have no bus node, got adj[bus]=%v", g.adj[bus])
	}
	for _, e := range g.adj[RouterNode("r1")] {
		if e.To == bus {
			t.Fatalf("r1 must not be wired to sw1's bus when sw1 has <2 points and no filtered link, got edge to %v", e.To)
		}
	}
}

func TestBuild_TwoFilteredSwitchLinksOnSameDomainPairUnionExports(t *testing.T) {
	// sw1a/sw1b merge into one domain, sw2a/sw2b merge into another; two
	// separate filtered links (sw1a-sw2a and sw1b-sw2b) both connect that
	// same pair of domains, each announcing a different subnet. Both must
	// stay reachable — the second link's announcement must not be
	// silently dropped in favor of the first.
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1a":  {Name: "r1a", Kind: topology.DeviceRouter},
			"r1b":  {Name: "r1b", Kind: topology.DeviceRouter},
			"r2a":  {Name: "r2a", Kind: topology.DeviceRouter},
			"r2b":  {Name: "r2b", Kind: topology.DeviceRouter},
			"sw1a": {Name: "sw1a", Kind: topology.DeviceSwitch},
			"sw1b": {Name: "sw1b", Kind: topology.DeviceSwitch},
			"sw2a": {Name: "sw2a", Kind: topology.DeviceSwitch},
			"sw2b": {Name: "sw2b", Kind: topology.DeviceSwitch},
		},
		Links: []topology.Link{
			{A: topology.Endpoint{Device: "r1a"}, B: topology.Endpoint{Device: "sw1a"}},
			{A: topology.Endpoint{Device: "r1b"}, B: topology.Endpoint{Device: "sw1b"}},
			{A: topology.Endpoint{Device: "r2a"}, B: topology.Endpoint{Device: "sw2a"}},
			{A: topology.Endpoint{Device: "r2b"}, B: topology.Endpoint{Device: "sw2b"}},
			{A: topology.Endpoint{Device: "sw1a"}, B: topology.Endpoint{Device: "sw1b"}},
			{A: topology.Endpoint{Device: "sw2a"}, B: topology.Endpoint{Device: "sw2b"}},
			{A: topology.Endpoint{Device: "sw1a"}, B: topology.Endpoint{Device: "sw2a"},
				Filter: &topology.LinkFilter{AExports: []string{"NA1"}, BExports: []string{"NB1"}}},
			{A: topology.Endpoint{Device: "sw1b"}, B: topology.Endpoint{Device: "sw2b"},
				Filter: &topology.LinkFilter{AExports: []string{"NA2"}, BExports: []string{"NB2"}}},
		},
		Subnets: map[string]topology.Subnet{
			"A1": {Name: "A1", CIDR: prefix(t, "10.0.0.0/24")},
			"A2": {Name: "A2", CIDR: prefix(t, "10.0.1.0/24")},
			"B1": {Name: "B1", CIDR: prefix(t, "10.0.2.0/24")},
			"B2": {Name: "B2", CIDR: prefix(t, "10.0.3.0/24")},
		},
		Networks: map[string]topology.Network{
			"NA1": netWithSubnets("NA1", []string{"A1"}, topology.Endpoint{Device: "r1a"}),
			"NA2": netWithSubnets("NA2", []string{"A2"}, topology.Endpoint{Device: "r1b"}),
			"NB1": netWithSubnets("NB1", []string{"B1"}, topology.Endpoint{Device: "r2a"}),
			"NB2": netWithSubnets("NB2", []string{"B2"}, topology.Endpoint{Device: "r2b"}),
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	g, err := Build(topo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for _, pair := range [][2]string{{"A1", "B1"}, {"A1", "B2"}, {"A2", "B1"}, {"A2", "B2"}} {
		paths, err := g.AllSimplePaths(SubnetNode(pair[0]), SubnetNode(pair[1]), DefaultLimits())
		if err != nil || len(paths) != 1 {
			t.Fatalf("%s->%s: got %d paths (%v), want 1 (union of both filtered links' exports)", pair[0], pair[1], len(paths), err)
		}
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
