package compiler

import (
	"fmt"
	"hash/crc32"
	"net/netip"
	"sort"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// atomicRule is a Rule with its OR-list Src/Dst expanded to a single name
// each, so every atomic rule maps to at most one ipset per side.
type atomicRule struct {
	Comment  string
	Src, Dst string
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
	Action   rules.Action
}

func expandAtomic(r rules.Rule) []atomicRule {
	comment := r.Comment
	if comment == "" {
		comment = r.Name
	}
	out := make([]atomicRule, 0, len(r.Src)*len(r.Dst))
	for _, s := range r.Src {
		for _, d := range r.Dst {
			out = append(out, atomicRule{Comment: comment, Src: s, Dst: d, Proto: r.Proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts, Action: r.Action})
			if r.Mirror {
				// Direction reverses, so what matched as the dst port now
				// matches as the src port, and vice versa.
				out = append(out, atomicRule{Comment: comment, Src: d, Dst: s, Proto: r.Proto, SrcPorts: r.DstPorts, DstPorts: r.SrcPorts, Action: r.Action})
			}
		}
	}
	return out
}

type pairKey struct{ src, dst string }

type deviceAccum struct {
	rules  []CompiledRule
	ips    []IPSet
	ipsets map[string]int // entity name -> index into ips
}

func (a *deviceAccum) addIPSetRef(entity, setName string) {
	if _, ok := a.ipsets[entity]; ok {
		return
	}
	if a.ipsets == nil {
		a.ipsets = make(map[string]int)
	}
	a.ipsets[entity] = len(a.ips)
	a.ips = append(a.ips, IPSet{Name: setName, DisplayName: entity})
}

func (a *deviceAccum) addRule(r CompiledRule) {
	key := ruleKey(r)
	for _, existing := range a.rules {
		if ruleKey(existing) == key {
			return
		}
	}
	a.rules = append(a.rules, r)
}

func ruleKey(r CompiledRule) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%v|%v|%s", r.SrcSet, r.DstSet, r.SrcAddr, r.DstAddr, r.Proto, r.SrcPorts, r.DstPorts, r.Action)
}

func (a *deviceAccum) ipsetList(topo *topology.Topology) []IPSet {
	out := append([]IPSet(nil), a.ips...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	for i := range out {
		cidrs := topo.EntityCIDRs(out[i].DisplayName)
		sort.Strings(cidrs)
		out[i].CIDRs = cidrs
	}
	return out
}

// ipsetNameMax is the kernel limit for an ipset name.
const ipsetNameMax = 31

// ipsetName derives a readable, ipset-safe set name from an entity name:
// "office-net" becomes "fn_office-net". Names too long for the kernel limit
// keep their readable head and gain a short hash tail to stay unique.
func ipsetName(entity string) string {
	s := "fn_" + sanitizeName(entity)
	if len(s) <= ipsetNameMax {
		return s
	}
	tail := "_" + fmt.Sprintf("%08x", crc32.ChecksumIEEE([]byte(entity)))
	return s[:ipsetNameMax-len(tail)] + tail
}

// sanitizeName keeps only characters valid in an ipset name; everything
// else collapses to '_'.
func sanitizeName(s string) string {
	out := []byte(s)
	for i, c := range out {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '_', c == '-', c == '.':
		default:
			out[i] = '_'
		}
	}
	return string(out)
}

// ipsetNamer assigns each entity one stable ipset name within a compile run.
// Entities whose sanitized names coincide ("a-b" vs "a_b") get a numeric
// suffix so a collision can never silently merge two different address sets.
type ipsetNamer struct {
	assigned map[string]string // entity -> ipset name
	taken    map[string]struct{}
}

func newIPSetNamer() *ipsetNamer {
	return &ipsetNamer{assigned: make(map[string]string), taken: make(map[string]struct{})}
}

func (n *ipsetNamer) get(entity string) string {
	if name, ok := n.assigned[entity]; ok {
		return name
	}
	name := ipsetName(entity)
	for seq := 2; ; seq++ {
		if _, taken := n.taken[name]; !taken {
			break
		}
		tail := fmt.Sprintf("_%d", seq)
		base := ipsetName(entity)
		if len(base)+len(tail) > ipsetNameMax {
			base = base[:ipsetNameMax-len(tail)]
		}
		name = base + tail
	}
	n.assigned[entity] = name
	n.taken[name] = struct{}{}
	return name
}

func routerNames(topo *topology.Topology) []string {
	out := make([]string, 0, len(topo.Devices))
	for name, d := range topo.Devices {
		if d.Kind == topology.DeviceRouter {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// Compile resolves every rule's src/dst to subnets, finds the routers that
// physically need each rule, and returns one ruleset per router that ended
// up with at least one rule. Routers no rule ever placed on are omitted —
// there's nothing for internal/render to produce beyond the same
// conntrack/default-action baseline every device would otherwise repeat.
func Compile(topo *topology.Topology, pol *rules.Policy, g *graph.Graph, limits graph.Limits) ([]DeviceRuleset, error) {
	allRouters := routerNames(topo)
	accum := make(map[string]*deviceAccum, len(allRouters))
	for _, r := range allRouters {
		accum[r] = &deviceAccum{}
	}

	pairCache := make(map[pairKey][]string)
	names := newIPSetNamer()

	for _, rule := range pol.Rules {
		for _, ar := range expandAtomic(rule) {
			srcAny := ar.Src == rules.Any
			dstAny := ar.Dst == rules.Any

			// resolveEndpoint maps an endpoint to the declared subnets
			// pathfinding should use. A literally written address/CIDR
			// anchors to the subnets overlapping it; the returned prefix
			// is non-nil only for that case (the rule matches the address
			// directly, no ipset is created).
			resolveEndpoint := func(ep, side string) ([]string, *netip.Prefix, error) {
				subs, err := topo.ResolveNetwork(ep)
				if err == nil {
					return subs, nil, nil
				}
				if p, ok := topology.ParseEndpointPrefix(ep); ok {
					return topo.SubnetsOverlapping(p), &p, nil
				}
				return nil, nil, fmt.Errorf("rule %q: %s %q: %w", rule.Name, side, ep, err)
			}

			var srcSubnets, dstSubnets []string
			var srcLit, dstLit *netip.Prefix
			var err error
			if !srcAny {
				if srcSubnets, srcLit, err = resolveEndpoint(ar.Src, "src"); err != nil {
					return nil, err
				}
			}
			if !dstAny {
				if dstSubnets, dstLit, err = resolveEndpoint(ar.Dst, "dst"); err != nil {
					return nil, err
				}
			}

			var targets []string
			if srcAny || dstAny || (srcLit != nil && len(srcSubnets) == 0) || (dstLit != nil && len(dstSubnets) == 0) {
				// One side is unbounded (e.g. real external traffic beyond
				// any declared subnet) — pathfinding can't tell which
				// routers are relevant, so place on all of them. This is
				// conservative: possibly a few extra devices, never a gap.
				targets = allRouters
			} else {
				routerSet := make(map[string]struct{})
				for _, s := range srcSubnets {
					for _, d := range dstSubnets {
						if s == d {
							continue // intra-subnet traffic never transits a managed router
						}
						key := pairKey{s, d}
						rs, ok := pairCache[key]
						if !ok {
							paths, perr := g.AllSimplePaths(graph.SubnetNode(s), graph.SubnetNode(d), limits)
							if perr != nil {
								return nil, fmt.Errorf("rule %q: path %s -> %s: %w", rule.Name, s, d, perr)
							}
							rs = graph.RoutersOnPaths(paths)
							pairCache[key] = rs
						}
						for _, r := range rs {
							routerSet[r] = struct{}{}
						}
					}
				}
				targets = make([]string, 0, len(routerSet))
				for r := range routerSet {
					targets = append(targets, r)
				}
				sort.Strings(targets)
			}

			compiled := CompiledRule{
				Comment:  ar.Comment,
				Proto:    ar.Proto,
				SrcPorts: ar.SrcPorts,
				DstPorts: ar.DstPorts,
				Action:   ar.Action,
			}
			var srcSet, dstSet string
			if !srcAny {
				if srcLit != nil {
					compiled.SrcAddr = srcLit.String()
				} else {
					srcSet = names.get(ar.Src)
				}
			}
			if !dstAny {
				if dstLit != nil {
					compiled.DstAddr = dstLit.String()
				} else {
					dstSet = names.get(ar.Dst)
				}
			}
			compiled.SrcSet, compiled.DstSet = srcSet, dstSet

			for _, target := range targets {
				a := accum[target]
				a.addRule(compiled)
				if srcSet != "" {
					a.addIPSetRef(ar.Src, srcSet)
				}
				if dstSet != "" {
					a.addIPSetRef(ar.Dst, dstSet)
				}
			}
		}
	}

	result := make([]DeviceRuleset, 0, len(allRouters))
	for _, name := range allRouters {
		a := accum[name]
		if len(a.rules) == 0 {
			continue
		}
		result = append(result, DeviceRuleset{
			Device:        name,
			IPSets:        a.ipsetList(topo),
			Rules:         a.rules,
			DefaultAction: pol.DefaultAction,
			ChainName:     pol.ChainName,
			ChainPosition: pol.ChainPosition,
		})
	}
	return result, nil
}
