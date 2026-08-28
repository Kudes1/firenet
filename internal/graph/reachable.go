package graph

import (
	"errors"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/topology"
)

// ReachableEntities returns the sorted names of networks and bare subnets
// reachable from device (router or switch) when topo.Links[skip] is excluded
// from the graph (skip < 0 keeps every link). A name qualifies if any of its
// subnets can be reached from a subnet attached to device, honoring the export
// rules of all other filtered links — so an entity counts as reachable both
// over plain links and across other filtered links that announce it.
func ReachableEntities(topo *topology.Topology, device string, skip int) ([]string, error) {
	trimmed := *topo
	trimmed.Links = make([]topology.Link, 0, len(topo.Links))
	for i, l := range topo.Links {
		if i != skip {
			trimmed.Links = append(trimmed.Links, l)
		}
	}

	g, err := Build(&trimmed)
	if err != nil {
		return nil, err
	}

	starts, err := startNodes(&trimmed, device)
	if err != nil {
		return nil, err
	}
	local := plainReachableSubnets(g, starts)
	if len(local) == 0 {
		return nil, nil // nothing attached: nothing is in reach
	}

	reachable := func(subs []string) bool {
		for _, dst := range subs {
			for _, src := range local {
				paths, err := g.AllSimplePaths(SubnetNode(src), SubnetNode(dst), DefaultLimits())
				if len(paths) > 0 {
					return true
				}
				var tooMany *ErrTooManyPaths
				if errors.As(err, &tooMany) {
					return true // paths exist, enumeration just overflowed
				}
			}
		}
		return false
	}

	var out []string
	for _, name := range sortedMapNames(topo.Networks) {
		subs, err := topo.ResolveNetwork(name)
		if err != nil {
			return nil, err
		}
		if reachable(subs) {
			out = append(out, name)
		}
	}
	for _, name := range sortedMapNames(topo.Subnets) {
		if reachable([]string{name}) {
			out = append(out, name)
		}
	}
	return out, nil
}

// startNodes resolves the graph node(s) standing in for device: a router
// is always its own single node. A switch has no node of its own — it is
// represented by its L2-domain bus (see Build) — but that bus node can
// have no edges in a graph built with one of its links excluded: Build
// only wires a domain's local points (routers, direct subnets) to its bus
// when the domain has >=2 of them or a surviving filtered link anchors
// it, and ReachableEntities always excludes the very link a caller is
// asking about — routinely a domain's only qualifying reason. So a switch
// resolves to every one of its domain's own attach points directly (each
// router on it, each subnet whose network attaches to it) in addition to
// the domain node itself — the domain node still matters when a
// *different*, still-present filtered link wires it onward elsewhere.
func startNodes(topo *topology.Topology, device string) ([]Node, error) {
	d, ok := topo.Devices[device]
	if !ok {
		return nil, fmt.Errorf("unknown device %q", device)
	}
	if d.Kind == topology.DeviceRouter {
		return []Node{RouterNode(device)}, nil
	}

	plainLinks, _ := splitSwitchLinks(topo)
	domainOf := assignL2Domains(topo, plainLinks)
	domain := domainOf[device]

	seen := map[Node]bool{}
	var starts []Node
	add := func(n Node) {
		if !seen[n] {
			seen[n] = true
			starts = append(starts, n)
		}
	}
	add(domainNode(domain))

	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		switch {
		case aIsSwitch && !bIsSwitch && domainOf[l.A.Device] == domain:
			add(RouterNode(l.B.Device))
		case bIsSwitch && !aIsSwitch && domainOf[l.B.Device] == domain:
			add(RouterNode(l.A.Device))
		}
	}
	for _, n := range topo.Networks {
		for _, ref := range n.Attach {
			if topo.Devices[ref.Device].Kind != topology.DeviceSwitch || domainOf[ref.Device] != domain {
				continue
			}
			for _, sname := range n.Subnets {
				add(SubnetNode(sname))
			}
		}
	}
	return starts, nil
}

// ValidateFilterExports checks every filtered link's export list against
// reachability with that same link excluded: exporting a network or subnet
// the device cannot otherwise reach would silently announce nothing.
func ValidateFilterExports(topo *topology.Topology) error {
	type side struct {
		label, dev string
		exports    []string
	}
	for i, l := range topo.Links {
		if l.Filter == nil {
			continue
		}
		for _, s := range []side{{"A", l.A.Device, l.Filter.AExports}, {"B", l.B.Device, l.Filter.BExports}} {
			reach, err := ReachableEntities(topo, s.dev, i)
			if err != nil {
				return fmt.Errorf("link[%d]: %w", i, err)
			}
			inReach := make(map[string]struct{}, len(reach))
			for _, n := range reach {
				inReach[n] = struct{}{}
			}
			for _, e := range s.exports {
				if _, ok := inReach[e]; !ok {
					return fmt.Errorf("link[%d]: export %q is not reachable from device %q (side %s)", i, e, s.dev, s.label)
				}
			}
		}
	}
	return nil
}

// plainReachableSubnets BFSes from every node in starts over unrestricted
// edges only (no filtered-link hops) and returns the subnet names reached
// — the seeds that count as "locally available" for export candidates.
// Going through switch domains counts, so a router behind a switch owns
// its segment's subnets.
func plainReachableSubnets(g *Graph, starts []Node) []string {
	seen := map[Node]bool{}
	var queue []Node
	for _, s := range starts {
		if !seen[s] {
			seen[s] = true
			queue = append(queue, s)
		}
	}
	var out []string
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.Kind == NodeSubnet {
			out = append(out, cur.Name)
		}
		for _, e := range g.adj[cur] {
			if e.Allow != nil || seen[e.To] {
				continue
			}
			seen[e.To] = true
			queue = append(queue, e.To)
		}
	}
	sort.Strings(out)
	return out
}

func sortedMapNames[V any](m map[string]V) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
