package diagnose

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

// Flow describes the diagnosed traffic: endpoints as IP addresses plus an
// optional protocol/port filter. Empty proto or empty port lists mean "any".
type Flow struct {
	Src, Dst netip.Addr
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
}

// StatelessNote accompanies every report: the diagnostic run evaluates the
// first packet of a new connection, so the conntrack ESTABLISHED,RELATED
// accept present on every device is deliberately out of scope.
const StatelessNote = "диагностика рассматривает первый пакет нового соединения; conntrack ESTABLISHED,RELATED не учитывается"

type Report struct {
	SrcSubnet string       `json:"srcSubnet"`
	DstSubnet string       `json:"dstSubnet"`
	Note      string       `json:"note"`
	Paths     []PathResult `json:"paths"`
	// ReturnPathAllowed reports whether traffic can also flow dst->src (any
	// protocol, unrestricted ports). The network layer is always symmetric
	// by construction (Build mirrors every filtered-link Allow both ways),
	// so this can only be false because of one-directional firewall rules
	// (no matching return rule or Mirror) — never because of routing.
	ReturnPathAllowed bool `json:"returnPathAllowed"`
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
	Steps       []string     `json:"steps,omitempty"`
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
func Run(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, flow Flow) (*Report, error) {
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
		rep.ReturnPathAllowed = true
		return rep, nil
	}

	byDevice := make(map[string]compiler.DeviceRuleset, len(sets))
	for _, rs := range sets {
		byDevice[rs.Device] = rs
	}
	paths, err := pathResults(byDevice, g, limits, srcName, dstName, flow)
	if err != nil {
		return nil, err
	}
	rep.Paths = paths

	// Reply traffic of the same session: addresses and ports swap the way
	// Mirror expands a rule (dst port becomes src port and vice versa).
	backFlow := Flow{Src: flow.Dst, Dst: flow.Src, Proto: flow.Proto, SrcPorts: flow.DstPorts, DstPorts: flow.SrcPorts}
	back, err := pathResults(byDevice, g, limits, dstName, srcName, backFlow)
	if err != nil {
		return nil, err
	}
	rep.ReturnPathAllowed = returnPathAllowed(back)
	return rep, nil
}

// pathResults enumerates every simple path from srcName to dstName and
// verdicts it against flow, same as Run's forward computation — Run calls
// this once forward and once more with names and flow endpoints swapped to
// check the return direction.
func pathResults(byDevice map[string]compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, srcName, dstName string, flow Flow) ([]PathResult, error) {
	paths, err := g.AllSimplePaths(graph.SubnetNode(srcName), graph.SubnetNode(dstName), limits)
	if err != nil {
		return nil, err
	}
	out := make([]PathResult, 0, len(paths))
	for _, p := range paths {
		pr := PathResult{Nodes: p.Nodes, Routers: []RouterVerdict{}}
		denied, returned := false, false
		for _, r := range p.Routers() {
			v := verdict(byDevice[r], flow, r)
			switch v.Action {
			case rules.ActionDeny:
				denied = true
			case rules.ActionReturn:
				returned = true
			}
			pr.Routers = append(pr.Routers, v)
		}
		switch {
		case denied:
			pr.Verdict = rules.ActionDeny
		case returned:
			pr.Verdict = rules.ActionReturn
		default:
			pr.Verdict = rules.ActionAllow
		}
		out = append(out, pr)
	}
	return out, nil
}

// returnPathAllowed reports whether at least one path back avoids an
// explicit deny verdict. Denying every path back is the only way this can
// be false, since route existence itself is guaranteed symmetric.
func returnPathAllowed(paths []PathResult) bool {
	for _, p := range paths {
		if p.Verdict != rules.ActionDeny {
			return true
		}
	}
	return false
}

// verdict walks the chain graph starting at the primary chain: jump descends,
// return ascends (or hands the packet back to FORWARD from the primary),
// terminal actions end the walk. The reason trail records every transition.
func verdict(rs compiler.DeviceRuleset, flow Flow, router string) RouterVerdict {
	if len(rs.Chains) == 0 {
		return RouterVerdict{Router: router, Action: rules.ActionAllow, Reason: "устройство не имеет скомпилированных цепочек — трафик проходит через него без фильтрации"}
	}
	type frame struct {
		name string
		from int
	}
	stack := []frame{{rs.Chains[0].Name, 0}}
	var trail []string
	var last *compiler.CompiledRule
	for len(stack) > 0 {
		top := len(stack) - 1
		cur := stack[top]
		m, idx := matchFrom(rs, cur.name, cur.from, flow)
		if m != nil {
			last = m
		}
		act := defaultOf(rs, cur.name)
		if m != nil {
			act = m.Action
		}
		switch act {
		case rules.ActionJump:
			detail := ruleDetail(rs, m)
			trail = append(trail, fmt.Sprintf("сработало правило %q (%s) — прыжок в цепочку %s", m.Comment, detail, m.JumpTo))
			stack[top].from = idx + 1
			stack = append(stack, frame{m.JumpTo, 0})
		case rules.ActionReturn:
			if len(stack) > 1 {
				trail = append(trail, fmt.Sprintf("цепочка %s возвращает трафик в вызывающую цепочку", cur.name))
				stack = stack[:len(stack)-1]
				continue
			}
			parts := append([]string(nil), trail...)
			if m != nil {
				parts = append(parts, fmt.Sprintf("сработало правило %q (%s)", m.Comment, ruleDetail(rs, m)))
			} else {
				parts = append(parts, "нет подходящих правил")
			}
			return RouterVerdict{Router: router, Action: rules.ActionReturn,
				MatchedRule: matchedComment(last), Reason: strings.Join(parts, "; ") + " — цепочка " + cur.name + " возвращает трафик в FORWARD", Steps: parts}
		default:
			parts := append([]string(nil), trail...)
			if m != nil {
				parts = append(parts, fmt.Sprintf("сработало правило %q (%s)", m.Comment, ruleDetail(rs, m)))
			} else {
				parts = append(parts, fmt.Sprintf("нет подходящих правил — применяется действие по умолчанию %q цепочки %s", act, cur.name))
			}
			return RouterVerdict{Router: router, Action: act, MatchedRule: matchedComment(last), Reason: strings.Join(parts, "; "), Steps: parts}
		}
	}
	// недостижимо: валидация исключает циклы, терминальные действия завершают обход
	return RouterVerdict{Router: router, Action: rules.ActionDeny, Reason: "исчерпан обход цепочек"}
}

func matchFrom(rs compiler.DeviceRuleset, chain string, from int, flow Flow) (*compiler.CompiledRule, int) {
	sub := rs
	sub.Rules = rs.Rules[from:]
	m := compiler.MatchFlowInChain(sub, chain, flow.Src, flow.Dst, flow.Proto, flow.SrcPorts, flow.DstPorts)
	if m == nil {
		return nil, -1
	}
	for i := range sub.Rules {
		if &sub.Rules[i] == m {
			return m, from + i
		}
	}
	return m, from
}

func defaultOf(rs compiler.DeviceRuleset, chain string) rules.Action {
	for _, ch := range rs.Chains {
		if ch.Name == chain {
			return ch.Default
		}
	}
	return rules.ActionDeny
}

func matchedComment(m *compiler.CompiledRule) string {
	if m == nil {
		return ""
	}
	return m.Comment
}

func ruleDetail(rs compiler.DeviceRuleset, m *compiler.CompiledRule) string {
	return fmt.Sprintf("src %s, dst %s, proto %s, порты src %s / dst %s",
		sideDesc(rs, m.SrcSet, m.SrcAddr, true),
		sideDesc(rs, m.DstSet, m.DstAddr, false),
		m.Proto, portsDesc(m.SrcPorts), portsDesc(m.DstPorts))
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
