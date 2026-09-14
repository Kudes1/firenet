package diagnose

import (
	"fmt"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/topology"
)

// MapMark is the server-computed map decoration for a Report: which map
// elements (networks and devices, addressed by name) to highlight, where
// the traffic flows, and where it is denied. Edges are canonical "a\0b"
// pairs of map element names (lexicographically ordered), matching what the
// scene renderer keys its wires and attaches by.
type MapMark struct {
	Highlight []string            `json:"hl"`
	Ok        []string            `json:"ok"`
	OkE       []string            `json:"okE"`
	DenyE     []string            `json:"denyE"`
	Half      []string            `json:"half"`
	HalfE     []string            `json:"halfE"`
	Deny      map[string]DenyInfo `json:"deny"`
}

// DenyInfo names the rule that produced the deny and why, for the map
// tooltip on the denying router.
type DenyInfo struct {
	Rule   string `json:"rule"`
	Reason string `json:"reason"`
}

// MarkMap translates the report's paths into map-space marks: report nodes
// (subnets, routers, synthetic L2 buses) are anchored to owning networks or
// routers, consecutive anchors are joined by the shortest physical device
// chain, and the flow is split at the first denying router. Deny beats
// half, half beats ok: an element marked deny is never also ok/half.
func MarkMap(topo *topology.Topology, rep *Report) *MapMark {
	m := &MapMark{
		Ok:    []string{},
		OkE:   []string{},
		DenyE: []string{},
		Half:  []string{},
		HalfE: []string{},
		Deny:  map[string]DenyInfo{},
	}
	if rep == nil || len(rep.Paths) == 0 {
		m.Highlight = []string{}
		return m
	}

	adj := buildAdj(topo)
	anchor := anchorOf(topo)
	for _, p := range rep.Paths {
		anchors := p.nodesAnchors(anchor)
		for _, a := range anchors {
			m.addHL(bare(a))
		}
		di := firstDeny(p)
		cut := len(anchors)
		var rv *RouterVerdict
		if di >= 0 {
			cut = indexOf(anchors, "d:"+repDenyRouter(p, di))
			rv = &p.Routers[di]
			if cut < 0 {
				continue // deny outside map anchors: the path is not marked
			}
		}
		// A degenerate path (same-subnet L2 traffic) has a single anchor and
		// no segments: its network lights up as fully ok.
		if len(anchors) == 1 {
			m.addOk(bare(anchors[0]))
			continue
		}
		for i := 0; i+1 < len(anchors); i++ {
			if anchors[i] == anchors[i+1] {
				continue
			}
			seg := shortestAdjPath(adj, anchors[i], anchors[i+1])
			if len(seg) == 0 {
				continue
			}
			bareSeg := make([]string, len(seg))
			for j, x := range seg {
				bareSeg[j] = bare(x)
			}
			edges := make([]string, 0, len(seg)-1)
			for j := 1; j < len(seg); j++ {
				edges = append(edges, edgeKey(bareSeg[j-1], bareSeg[j]))
			}
			switch {
			case rv != nil && i+1 > cut:
				m.addDenyE(edges...)
				m.addHL(bareSeg...)
			case rv != nil && i+1 == cut:
				m.addOk(bareSeg[:len(bareSeg)-1]...)
				m.addOkE(edges...)
				m.addHL(bareSeg...)
				if len(bareSeg) > 0 {
					m.Deny[bareSeg[len(bareSeg)-1]] = DenyInfo{Rule: rv.MatchedRule, Reason: rv.Reason}
				}
			default:
				m.addOk(bareSeg...)
				m.addOkE(edges...)
				m.addHL(bareSeg...)
			}
		}
	}

	// deny beats ok on nodes too
	for r := range m.Deny {
		m.removeOk(r)
	}

	// no return path: every ok element degrades to half
	if !rep.ReturnPathAllowed {
		m.Half = append(m.Half, m.Ok...)
		m.HalfE = append(m.HalfE, m.OkE...)
		m.Ok = []string{}
		m.OkE = []string{}
	}
	return m
}

func (m *MapMark) addHL(names ...string) {
	for _, n := range names {
		if !containsStr(m.Highlight, n) {
			m.Highlight = append(m.Highlight, n)
		}
	}
}

func (m *MapMark) addOk(names ...string) {
	for _, n := range names {
		if !containsStr(m.Ok, n) {
			m.Ok = append(m.Ok, n)
		}
	}
}

func (m *MapMark) addOkE(keys ...string) {
	for _, k := range keys {
		if !containsStr(m.OkE, k) {
			m.OkE = append(m.OkE, k)
		}
	}
}

func (m *MapMark) addDenyE(keys ...string) {
	for _, k := range keys {
		if !containsStr(m.DenyE, k) {
			m.DenyE = append(m.DenyE, k)
		}
	}
}

func (m *MapMark) removeOk(name string) {
	for i, n := range m.Ok {
		if n == name {
			m.Ok = append(m.Ok[:i], m.Ok[i+1:]...)
			return
		}
	}
}

// nodeAnchors maps one path's report nodes to qualified map anchors
// ("d:router"/"n:network"); unanchorable nodes (an L2 bus with no twin) drop out.
func (p PathResult) nodesAnchors(anchor func(graph.Node) string) []string {
	out := make([]string, 0, len(p.Nodes))
	for _, n := range p.Nodes {
		if a := anchor(n); a != "" {
			out = append(out, a)
		}
	}
	return out
}

func firstDeny(p PathResult) int {
	for i, rv := range p.Routers {
		if rv.Action == "deny" {
			return i
		}
	}
	return -1
}

func repDenyRouter(p PathResult, di int) string {
	return p.Routers[di].Router
}

// The map namespaces networks and devices separately (a network and a router
// may share one name); report nodes are qualified so they never merge.
const (
	devPrefix = "d:"
	netPrefix = "n:"
)

func bare(k string) string { return k[len(devPrefix):] }

// anchorOf maps a report node to its map anchor: routers to themselves,
// subnets to their owning network (nil for a subnet without one).
func anchorOf(topo *topology.Topology) func(graph.Node) string {
	return func(n graph.Node) string {
		switch n.Kind {
		case graph.NodeRouter:
			return devPrefix + n.Name
		default:
			for name, w := range topo.Networks {
				for _, sn := range w.Subnets {
					if sn == n.Name {
						return netPrefix + name
					}
				}
			}
			return ""
		}
	}
}

// buildAdj builds the symmetric physical adjacency of the map: device–device
// links plus network–device attaches. Keys are qualified.
func buildAdj(topo *topology.Topology) map[string][]string {
	adj := make(map[string][]string)
	link := func(a, b string) {
		adj[a] = append(adj[a], b)
	}
	for _, l := range topo.Links {
		a, b := devPrefix+l.A.Device, devPrefix+l.B.Device
		link(a, b)
		link(b, a)
	}
	for name, n := range topo.Networks {
		for _, a := range n.Attach {
			link(netPrefix+name, devPrefix+a.Device)
			link(devPrefix+a.Device, netPrefix+name)
		}
	}
	return adj
}

// shortestAdjPath BFS from one qualified anchor to another over the physical
// adjacency; nil when unreachable.
func shortestAdjPath(adj map[string][]string, from, to string) []string {
	if from == to {
		return []string{from}
	}
	prev := map[string]string{from: ""}
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, next := range adj[cur] {
			if _, seen := prev[next]; seen {
				continue
			}
			prev[next] = cur
			if next == to {
				path := []string{to}
				for p := cur; p != ""; p = prev[p] {
					path = append([]string{p}, path...)
				}
				return path
			}
			queue = append(queue, next)
		}
	}
	return nil
}

// edgeKey canonicalizes an unordered pair of map element names into one
// edge key, matching the renderer's wire keys.
func edgeKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return fmt.Sprintf("%s\x00%s", a, b)
}

func indexOf(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

func containsStr(list []string, s string) bool {
	return indexOf(list, s) >= 0
}
