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
			{A: topology.Endpoint{Device: "r1", Interface: "up"}, B: topology.Endpoint{Device: "r2", Interface: "down"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "r1", Interface: "a0"}),
			"nB": netWithSubnets("nB", []string{"B"}, topology.Endpoint{Device: "r2", Interface: "b0"}),
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
				topology.Endpoint{Device: "r1", Interface: "a0"}, topology.Endpoint{Device: "r2", Interface: "a0"}),
			"nB": netWithSubnets("nB", []string{"B"},
				topology.Endpoint{Device: "r1", Interface: "b0"}, topology.Endpoint{Device: "r2", Interface: "b0"}),
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
			{A: topology.Endpoint{Device: "r1", Interface: "up"}, B: topology.Endpoint{Device: "sw1", Interface: "p1"}},
			{A: topology.Endpoint{Device: "sw1", Interface: "p2"}, B: topology.Endpoint{Device: "sw2", Interface: "p1"}},
		},
		Subnets: map[string]topology.Subnet{
			"X": {Name: "X", CIDR: prefix(t, "10.0.0.0/24")},
			"A": {Name: "A", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nX": netWithSubnets("nX", []string{"X"}, topology.Endpoint{Device: "r1", Interface: "x0"}),
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "sw2", Interface: "p2"}),
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
			"n": netWithSubnets("n", []string{"A", "B"}, topology.Endpoint{Device: "r1", Interface: "lan0"}),
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
			{A: topology.Endpoint{Device: "r1", Interface: "toR2"}, B: topology.Endpoint{Device: "r2", Interface: "toR1"}},
			{A: topology.Endpoint{Device: "r1", Interface: "toR3"}, B: topology.Endpoint{Device: "r3", Interface: "toR1"}},
			{A: topology.Endpoint{Device: "r2", Interface: "toR3"}, B: topology.Endpoint{Device: "r3", Interface: "toR2"}},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
		},
		Networks: map[string]topology.Network{
			"nA": netWithSubnets("nA", []string{"A"}, topology.Endpoint{Device: "r1", Interface: "a0"}),
			"nB": netWithSubnets("nB", []string{"B"}, topology.Endpoint{Device: "r2", Interface: "b0"}),
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

func TestAllSimplePaths_TooManyPaths(t *testing.T) {
	devices := map[string]topology.Device{}
	var epsA, epsB []topology.Endpoint
	for i := 0; i < 4; i++ {
		name := "r" + string(rune('1'+i))
		devices[name] = topology.Device{Name: name, Kind: topology.DeviceRouter}
		epsA = append(epsA, topology.Endpoint{Device: name, Interface: "a0"})
		epsB = append(epsB, topology.Endpoint{Device: name, Interface: "b0"})
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
