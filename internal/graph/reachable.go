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

	start, err := startNode(&trimmed, device)
	if err != nil {
		return nil, err
	}
	local := plainReachableSubnets(g, start)
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

// startNode resolves the graph node standing in for device: a router is
// its own node, a switch is the L2-domain bus it belongs to (switches
// never appear as their own graph node — see Build). If the domain bus is
// not present in the graph due to a single attachment point and no filtered
// links, fall back to that attachment point (usually a router).
func startNode(topo *topology.Topology, device string) (Node, error) {
	d, ok := topo.Devices[device]
	if !ok {
		return Node{}, fmt.Errorf("unknown device %q", device)
	}
	if d.Kind == topology.DeviceRouter {
		return RouterNode(device), nil
	}
	plainLinks, _ := splitSwitchLinks(topo)
	domainOf := assignL2Domains(topo, plainLinks)
	domain := domainOf[device]

	// Find router attachment points for this domain.
	var routerAttachPoints []string
	for _, l := range topo.Links {
		aIsSwitch := topo.Devices[l.A.Device].Kind == topology.DeviceSwitch
		bIsSwitch := topo.Devices[l.B.Device].Kind == topology.DeviceSwitch
		if aIsSwitch && !bIsSwitch && domainOf[l.A.Device] == domain {
			routerAttachPoints = append(routerAttachPoints, l.B.Device)
		} else if bIsSwitch && !aIsSwitch && domainOf[l.B.Device] == domain {
			routerAttachPoints = append(routerAttachPoints, l.A.Device)
		}
	}

	// If the domain has exactly one router attachment and no subnets
	// attached directly to it, use the router as start point (the domain
	// node won't exist in the graph for this case).
	if len(routerAttachPoints) == 1 {
		// Check for direct subnet attachments to the domain.
		for _, n := range topo.Networks {
			for _, ref := range n.Attach {
				if topo.Devices[ref.Device].Kind == topology.DeviceSwitch &&
					domainOf[ref.Device] == domain {
					// There's a subnet attached to the domain; use domain node.
					return domainNode(domain), nil
				}
			}
		}
		// Only one router attachment, no subnet attachments: use that router.
		return RouterNode(routerAttachPoints[0]), nil
	}

	// Multiple attachment points or none; use domain node.
	return domainNode(domain), nil
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
