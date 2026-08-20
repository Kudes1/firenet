// Package graph derives a router/subnet reachability graph from a topology,
// collapsing switches (which exist only for L2 connectivity) into virtual
// direct edges, and finds the paths policy rules need for placement.
package graph

import (
	"github.com/kudes1/firenet/internal/topology"
)

type NodeKind int

const (
	NodeRouter NodeKind = iota
	NodeSubnet
)

// Node is one vertex of the graph: a managed router or a named subnet.
// Switches never appear here — they are collapsed away in Build.
type Node struct {
	Kind NodeKind
	Name string
}

func RouterNode(name string) Node { return Node{Kind: NodeRouter, Name: name} }
func SubnetNode(name string) Node { return Node{Kind: NodeSubnet, Name: name} }

func (n Node) String() string {
	if n.Kind == NodeRouter {
		return "router:" + n.Name
	}
	return "subnet:" + n.Name
}

// Edge is a directed graph edge, annotated with the interface used on the
// "from" side (empty when "from" is a subnet node).
type Edge struct {
	To         Node
	LocalIface string
}

// Graph is a router/subnet adjacency list built from a Topology.
type Graph struct {
	adj map[Node][]Edge
}

func newGraph() *Graph {
	return &Graph{adj: make(map[Node][]Edge)}
}

func (g *Graph) addEdge(from, to Node, localIface string) {
	for _, e := range g.adj[from] {
		if e.To == to {
			return
		}
	}
	g.adj[from] = append(g.adj[from], Edge{To: to, LocalIface: localIface})
}

func (g *Graph) addUndirected(a, b Node, ifaceA, ifaceB string) {
	g.addEdge(a, b, ifaceA)
	g.addEdge(b, a, ifaceB)
}

// attachPoint is one endpoint reachable from within a single L2 domain (or
// directly, without a switch in between).
type attachPoint struct {
	node  Node
	iface string // interface on the router side; empty for subnet points
}

// Build derives the router/subnet graph. It assumes topo has already passed
// Validate (interface/link references are known to be well-formed).
func Build(topo *topology.Topology) (*Graph, error) {
	g := newGraph()

	var switchLinks []topology.Link
	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		switch {
		case aIsSwitch && bIsSwitch:
			switchLinks = append(switchLinks, l)
		case !aIsSwitch && !bIsSwitch:
			g.addUndirected(RouterNode(l.A.Device), RouterNode(l.B.Device), l.A.Interface, l.B.Interface)
		}
	}

	domainOf := assignL2Domains(topo, switchLinks)

	domainPoints := make(map[int][]attachPoint)
	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		switch {
		case aIsSwitch && !bIsSwitch:
			id := domainOf[l.A.Device]
			domainPoints[id] = append(domainPoints[id], attachPoint{node: RouterNode(l.B.Device), iface: l.B.Interface})
		case bIsSwitch && !aIsSwitch:
			id := domainOf[l.B.Device]
			domainPoints[id] = append(domainPoints[id], attachPoint{node: RouterNode(l.A.Device), iface: l.A.Interface})
		}
	}

	for name, s := range topo.Subnets {
		for _, ref := range s.AttachedTo {
			dev := topo.Devices[ref.Device]
			switch dev.Kind {
			case topology.DeviceSwitch:
				id := domainOf[ref.Device]
				domainPoints[id] = append(domainPoints[id], attachPoint{node: SubnetNode(name)})
			case topology.DeviceRouter:
				g.addUndirected(RouterNode(ref.Device), SubnetNode(name), ref.Interface, "")
			}
		}
	}

	for _, points := range domainPoints {
		for i := 0; i < len(points); i++ {
			for j := i + 1; j < len(points); j++ {
				p1, p2 := points[i], points[j]
				if p1.node.Kind == NodeSubnet && p2.node.Kind == NodeSubnet {
					continue // hosts on the same L2 segment don't transit a managed router
				}
				g.addUndirected(p1.node, p2.node, p1.iface, p2.iface)
			}
		}
	}

	return g, nil
}

// assignL2Domains groups switch devices into connected components (L2
// domains) via switch-to-switch links. Every switch gets a domain, even one
// with no switch-switch links of its own (a lone switch is its own domain).
func assignL2Domains(topo *topology.Topology, switchLinks []topology.Link) map[string]int {
	adj := make(map[string][]string)
	for _, l := range switchLinks {
		adj[l.A.Device] = append(adj[l.A.Device], l.B.Device)
		adj[l.B.Device] = append(adj[l.B.Device], l.A.Device)
	}

	domainOf := make(map[string]int)
	nextID := 0
	for name, d := range topo.Devices {
		if d.Kind != topology.DeviceSwitch {
			continue
		}
		if _, ok := domainOf[name]; ok {
			continue
		}
		id := nextID
		nextID++
		queue := []string{name}
		domainOf[name] = id
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			for _, nb := range adj[cur] {
				if _, ok := domainOf[nb]; !ok {
					domainOf[nb] = id
					queue = append(queue, nb)
				}
			}
		}
	}
	return domainOf
}
