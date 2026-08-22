// Package graph derives a router/subnet reachability graph from a topology,
// representing each switch as a single L2-domain bus node, and finds the
// paths policy rules need for placement.
package graph

import (
	"fmt"

	"github.com/kudes1/firenet/internal/topology"
)

type NodeKind int

const (
	NodeRouter NodeKind = iota
	NodeSubnet
	// NodeDomain is a synthetic node standing in for one switch L2 domain.
	// It lets two devices sharing a switch reach each other in exactly one
	// hop without a simple path being able to detour through a third,
	// unrelated device on the same domain (a bus node can't be revisited).
	NodeDomain
)

// Node is one vertex of the graph: a managed router, a named subnet, or a
// synthetic L2-domain bus. Switches themselves never appear as devices here
// — each switch L2 domain is represented by one NodeDomain bus in Build.
type Node struct {
	Kind NodeKind
	Name string
}

func RouterNode(name string) Node { return Node{Kind: NodeRouter, Name: name} }
func SubnetNode(name string) Node { return Node{Kind: NodeSubnet, Name: name} }
func domainNode(id int) Node      { return Node{Kind: NodeDomain, Name: fmt.Sprintf("l2-%d", id)} }

func (n Node) String() string {
	switch n.Kind {
	case NodeRouter:
		return "router:" + n.Name
	case NodeDomain:
		return "domain:" + n.Name
	default:
		return "subnet:" + n.Name
	}
}

// Edge is a directed graph edge.
type Edge struct {
	To Node
	// Allow, when non-nil, carries only announced traffic: a path using
	// this edge must have src ∈ From and dst ∈ To (filtered-link rules).
	Allow *edgeAllow
}

// edgeAllow holds the subnet names each side of a filtered link announces
// across it, resolved at Build time.
type edgeAllow struct {
	From, To map[string]struct{}
}

// Graph is a router/subnet adjacency list built from a Topology.
type Graph struct {
	adj map[Node][]Edge
}

func newGraph() *Graph {
	return &Graph{adj: make(map[Node][]Edge)}
}

func (g *Graph) addEdge(from, to Node) {
	g.addEdgeAllow(from, to, nil)
}

func (g *Graph) addEdgeAllow(from, to Node, allow *edgeAllow) {
	for _, e := range g.adj[from] {
		if e.To == to {
			return
		}
	}
	g.adj[from] = append(g.adj[from], Edge{To: to, Allow: allow})
}

func (g *Graph) addUndirected(a, b Node) {
	g.addEdge(a, b)
	g.addEdge(b, a)
}

// attachPoint is one endpoint reachable from within a single L2 domain (or
// directly, without a switch in between).
type attachPoint struct {
	node Node
}

// Build derives the router/subnet graph. It assumes topo has already passed
// Validate (link references are known to be well-formed).
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
			var ab, ba *edgeAllow
			if l.Filter != nil {
				from, err := exportSubnets(topo, l.Filter.AExports)
				if err != nil {
					return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
				}
				to, err := exportSubnets(topo, l.Filter.BExports)
				if err != nil {
					return nil, fmt.Errorf("link %s-%s: %w", l.A.Device, l.B.Device, err)
				}
				ab = &edgeAllow{From: from, To: to}
				ba = &edgeAllow{From: to, To: from}
			}
			g.addEdgeAllow(RouterNode(l.A.Device), RouterNode(l.B.Device), ab)
			g.addEdgeAllow(RouterNode(l.B.Device), RouterNode(l.A.Device), ba)
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
			domainPoints[id] = append(domainPoints[id], attachPoint{node: RouterNode(l.B.Device)})
		case bIsSwitch && !aIsSwitch:
			id := domainOf[l.B.Device]
			domainPoints[id] = append(domainPoints[id], attachPoint{node: RouterNode(l.A.Device)})
		}
	}

	// Every subnet inherits the attachment of its owning network (one
	// network = one L2 segment; Validate guarantees a single owner).
	for _, n := range topo.Networks {
		for _, ref := range n.Attach {
			dev := topo.Devices[ref.Device]
			for _, sname := range n.Subnets {
				switch dev.Kind {
				case topology.DeviceSwitch:
					id := domainOf[ref.Device]
					domainPoints[id] = append(domainPoints[id], attachPoint{node: SubnetNode(sname)})
				case topology.DeviceRouter:
					g.addUndirected(RouterNode(ref.Device), SubnetNode(sname))
				}
			}
		}
	}

	for id, points := range domainPoints {
		if len(points) < 2 {
			continue // nothing on the other side of this switch to reach
		}
		bus := domainNode(id)
		for _, p := range points {
			g.addUndirected(p.node, bus)
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

// exportSubnets flattens export entity names (networks or bare subnets)
// into one deduplicated subnet-name set.
func exportSubnets(topo *topology.Topology, names []string) (map[string]struct{}, error) {
	out := make(map[string]struct{}, len(names))
	for _, name := range names {
		subs, err := topo.ResolveNetwork(name)
		if err != nil {
			return nil, err
		}
		for _, s := range subs {
			out[s] = struct{}{}
		}
	}
	return out, nil
}
