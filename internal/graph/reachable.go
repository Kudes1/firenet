package graph

import (
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/topology"
)

// ReachableEntities returns the sorted names of networks and bare subnets
// reachable from router device when topo.Links[skip] and every filtered link
// are excluded from the graph. A filtered-link export may only announce
// locally available entities, never entities learned through another filter.
// Ordinary links retain their full-connectivity semantics.
func ReachableEntities(topo *topology.Topology, device string, skip int) ([]string, error) {
	trimmed := *topo
	trimmed.Links = make([]topology.Link, 0, len(topo.Links))
	for i, l := range topo.Links {
		if i != skip && l.Filter == nil {
			trimmed.Links = append(trimmed.Links, l)
		}
	}

	g, err := Build(&trimmed)
	if err != nil {
		return nil, err
	}

	local := plainReachableSubnets(g, RouterNode(device))
	if len(local) == 0 {
		return nil, nil // nothing attached: nothing is in reach
	}

	localSet := make(map[string]struct{}, len(local))
	for _, name := range local {
		localSet[name] = struct{}{}
	}

	var out []string
	for _, name := range sortedMapNames(topo.Networks) {
		subs, err := topo.ResolveNetwork(name)
		if err != nil {
			return nil, err
		}
		for _, sub := range subs {
			if _, ok := localSet[sub]; ok {
				out = append(out, name)
				break
			}
		}
	}
	for _, name := range sortedMapNames(topo.Subnets) {
		if _, ok := localSet[name]; ok {
			out = append(out, name)
		}
	}
	return out, nil
}

// ValidateFilterExports checks every filtered link's export list against
// local reachability with that same link excluded: exporting a network or
// subnet learned through another filtered link would silently re-export it.
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
					return fmt.Errorf("link[%d]: export %q is not reachable from router %q (side %s)", i, e, s.dev, s.label)
				}
			}
		}
	}
	return nil
}

// plainReachableSubnets BFSes from start over unrestricted edges only (no
// filtered-link hops) and returns the subnet names reached. Going through
// switch domains counts, so a router behind a switch owns its segment's
// subnets.
func plainReachableSubnets(g *Graph, start Node) []string {
	seen := map[Node]bool{start: true}
	queue := []Node{start}
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
