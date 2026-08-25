package graph

import (
	"errors"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/topology"
)

// ReachableEntities returns the sorted names of networks and bare subnets
// reachable from router device when topo.Links[skip] is excluded from the
// graph (skip < 0 keeps every link). A name qualifies if any of its subnets
// can be reached from a subnet attached to device, honoring the export
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

	local := plainReachableSubnets(g, RouterNode(device))
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
					return fmt.Errorf("link[%d]: export %q is not reachable from router %q (side %s)", i, e, s.dev, s.label)
				}
			}
		}
	}
	return nil
}

// plainReachableSubnets BFSes from start over unrestricted edges only (no
// filtered-link hops) and returns the subnet names reached — the seeds that
// count as "locally available" for export candidates. Going through switch
// domains counts, so a router behind a switch owns its segment's subnets.
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
