package graph

import (
	"fmt"
	"sort"
)

// Limits bounds path enumeration so a dense graph can't blow up compilation.
type Limits struct {
	MaxHops  int
	MaxPaths int
}

// DefaultLimits are conservative bounds suitable for hand-built topologies.
func DefaultLimits() Limits {
	return Limits{MaxHops: 8, MaxPaths: 64}
}

// Path is one simple (cycle-free) route through the graph, endpoints
// included.
type Path struct {
	Nodes []Node
}

// Routers returns the transit router names on this path, excluding the
// endpoint subnet nodes.
func (p Path) Routers() []string {
	var out []string
	for _, n := range p.Nodes {
		if n.Kind == NodeRouter {
			out = append(out, n.Name)
		}
	}
	return out
}

// ErrTooManyPaths is returned instead of silently truncating results: for a
// firewall compiler, an explicit failure beats quietly dropping a transit
// router from a defense-in-depth placement.
type ErrTooManyPaths struct {
	Src, Dst Node
	Limit    int
}

func (e *ErrTooManyPaths) Error() string {
	return fmt.Sprintf("too many simple paths between %s and %s (limit %d); narrow the topology or raise the limit", e.Src, e.Dst, e.Limit)
}

// AllSimplePaths enumerates every simple path between src and dst, bounded
// by limits.
func (g *Graph) AllSimplePaths(src, dst Node, limits Limits) ([]Path, error) {
	if limits.MaxHops <= 0 || limits.MaxPaths <= 0 {
		limits = DefaultLimits()
	}

	var paths []Path
	visited := map[Node]bool{src: true}
	stack := []Node{src}

	var dfs func(cur Node) error
	dfs = func(cur Node) error {
		if cur == dst {
			nodes := make([]Node, len(stack))
			copy(nodes, stack)
			paths = append(paths, Path{Nodes: nodes})
			if len(paths) > limits.MaxPaths {
				return &ErrTooManyPaths{Src: src, Dst: dst, Limit: limits.MaxPaths}
			}
			return nil
		}
		if len(stack) > limits.MaxHops {
			return nil
		}
		for _, e := range g.adj[cur] {
			if visited[e.To] {
				continue
			}
			visited[e.To] = true
			stack = append(stack, e.To)
			if err := dfs(e.To); err != nil {
				return err
			}
			stack = stack[:len(stack)-1]
			delete(visited, e.To)
		}
		return nil
	}

	if err := dfs(src); err != nil {
		return nil, err
	}
	return paths, nil
}

// RoutersOnPaths returns the sorted union of transit routers across all
// paths. This is the single place to change if a future enforcement
// strategy (e.g. perimeter-only) replaces "every transit hop".
func RoutersOnPaths(paths []Path) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, p := range paths {
		for _, r := range p.Routers() {
			if _, ok := seen[r]; !ok {
				seen[r] = struct{}{}
				out = append(out, r)
			}
		}
	}
	sort.Strings(out)
	return out
}
