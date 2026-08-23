package simulate

import (
	"fmt"
	"sort"
	"strings"

	"net/netip"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// Flow describes the simulated traffic: endpoints as IP addresses plus an
// optional protocol/port filter. Empty proto or empty port lists mean "any".
type Flow struct {
	Src, Dst netip.Addr
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
}

// StatelessNote accompanies every report: the simulation evaluates the first
// packet of a new connection, so the conntrack ESTABLISHED,RELATED accept
// present on every device is deliberately out of scope.
const StatelessNote = "симуляция рассматривает первый пакет нового соединения; conntrack ESTABLISHED,RELATED не учитывается"

type Report struct {
	SrcSubnet string       `json:"srcSubnet"`
	DstSubnet string       `json:"dstSubnet"`
	Note      string       `json:"note"`
	Paths     []PathResult `json:"paths"`
}

type PathResult struct {
	Nodes   []graph.Node    `json:"nodes"`
	Routers []RouterVerdict `json:"routers"`
	Verdict rules.Action    `json:"verdict"`
	Note    string          `json:"note,omitempty"`
}

type RouterVerdict struct {
	Router      string       `json:"router"`
	Action      rules.Action `json:"action"`
	MatchedRule string       `json:"matchedRule,omitempty"`
	Reason      string       `json:"reason"`
}

// ResolveIP maps an address to the declared entity it belongs to: the first
// subnet (sorted-name order) whose CIDR contains it, else the first set with
// a matching host address.
func ResolveIP(topo *topology.Topology, addr netip.Addr) (string, error) {
	names := make([]string, 0, len(topo.Subnets))
	for n := range topo.Subnets {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if topo.Subnets[n].CIDR.Contains(addr) {
			return n, nil
		}
	}
	setNames := make([]string, 0, len(topo.Sets))
	for n := range topo.Sets {
		setNames = append(setNames, n)
	}
	sort.Strings(setNames)
	for _, n := range setNames {
		for _, p := range topo.Sets[n].Addresses {
			if p.Contains(addr) {
				return n, nil
			}
		}
	}
	return "", fmt.Errorf("IP %s не принадлежит ни одной подсети или набору", addr)
}

// Run answers "how would traffic flow": resolve endpoints to subnets, list
// every simple path exactly like the compiler does, and produce a per-router
// verdict over that device's compiled rules. A path is denied at its first
// denying router; otherwise allowed.
func Run(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, defaultAction rules.Action, flow Flow) (*Report, error) {
	srcName, err := ResolveIP(topo, flow.Src)
	if err != nil {
		return nil, fmt.Errorf("src: %w", err)
	}
	dstName, err := ResolveIP(topo, flow.Dst)
	if err != nil {
		return nil, fmt.Errorf("dst: %w", err)
	}
	// Пустые слайсы, а не nil: JSON null ломает фронтенд (.length/.forEach).
	rep := &Report{SrcSubnet: srcName, DstSubnet: dstName, Note: StatelessNote, Paths: []PathResult{}}
	if srcName == dstName {
		rep.Paths = []PathResult{{
			Nodes:   []graph.Node{graph.SubnetNode(srcName)},
			Routers: []RouterVerdict{},
			Verdict: rules.ActionAllow,
			Note:    "трафик не пересекает управляемые роутеры (L2-сегмент)",
		}}
		return rep, nil
	}

	byDevice := make(map[string]compiler.DeviceRuleset, len(sets))
	for _, rs := range sets {
		byDevice[rs.Device] = rs
	}
	paths, err := g.AllSimplePaths(graph.SubnetNode(srcName), graph.SubnetNode(dstName), limits)
	if err != nil {
		return nil, err
	}
	for _, p := range paths {
		pr := PathResult{Nodes: p.Nodes, Routers: []RouterVerdict{}}
		denied := false
		for _, r := range p.Routers() {
			v := verdict(byDevice[r], defaultAction, flow, r)
			if v.Action == rules.ActionDeny {
				denied = true
			}
			pr.Routers = append(pr.Routers, v)
		}
		if denied {
			pr.Verdict = rules.ActionDeny
		} else {
			pr.Verdict = rules.ActionAllow
		}
		rep.Paths = append(rep.Paths, pr)
	}
	return rep, nil
}

func verdict(rs compiler.DeviceRuleset, def rules.Action, flow Flow, router string) RouterVerdict {
	matched := compiler.MatchFlow(rs, flow.Src, flow.Dst, flow.Proto, flow.SrcPorts, flow.DstPorts)
	if matched == nil {
		return RouterVerdict{
			Router: router,
			Action: def,
			Reason: fmt.Sprintf("нет подходящих правил — применяется действие по умолчанию %q", def),
		}
	}
	return RouterVerdict{
		Router:      router,
		Action:      matched.Action,
		MatchedRule: matched.Comment,
		Reason: fmt.Sprintf("сработало правило %q (%s): src %s, dst %s, proto %s, порты src %s / dst %s",
			matched.Comment, matched.Action,
			sideDesc(rs, matched.SrcSet, matched.SrcAddr, true),
			sideDesc(rs, matched.DstSet, matched.DstAddr, false),
			matched.Proto, portsDesc(matched.SrcPorts), portsDesc(matched.DstPorts)),
	}
}

func sideDesc(rs compiler.DeviceRuleset, set, literal string, src bool) string {
	side := "dst"
	if src {
		side = "src"
	}
	switch {
	case set != "":
		for _, s := range rs.IPSets {
			if s.Name == set {
				return side + ": ipset " + s.DisplayName
			}
		}
		return side + ": ipset " + set
	case literal != "":
		return side + ": адрес " + literal
	default:
		return side + ": любой"
	}
}

func portsDesc(ports []string) string {
	if len(ports) == 0 {
		return "любые"
	}
	return strings.Join(ports, ",")
}
