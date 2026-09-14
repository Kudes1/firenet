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
	JumpTo   string
	Chain    string
}

func expandAtomic(r rules.Rule) []atomicRule {
	comment := r.Comment
	if comment == "" {
		comment = r.Name
	}
	out := make([]atomicRule, 0, len(r.Src)*len(r.Dst))
	for _, s := range r.Src {
		for _, d := range r.Dst {
			out = append(out, atomicRule{Comment: comment, Src: s, Dst: d, Proto: r.Proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts, Action: r.Action, JumpTo: r.JumpTo})
			if r.Mirror {
				// Direction reverses, so what matched as the dst port now
				// matches as the src port, and vice versa.
				out = append(out, atomicRule{Comment: comment, Src: d, Dst: s, Proto: r.Proto, SrcPorts: r.DstPorts, DstPorts: r.SrcPorts, Action: r.Action, JumpTo: r.JumpTo})
			}
		}
	}
	return out
}

type pairKey struct{ src, dst string }

type deviceAccum struct {
	rules    []CompiledRule
	ips      []IPSet
	ipsets   map[string]int // entity name -> index into ips
	chainIdx map[string]int // chain name -> index into chains
	chains   []CompiledChain
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

func (a *deviceAccum) ensureChain(name string, cc CompiledChain) {
	if _, ok := a.chainIdx[name]; ok {
		return
	}
	if a.chainIdx == nil {
		a.chainIdx = make(map[string]int)
	}
	a.chainIdx[name] = len(a.chains)
	a.chains = append(a.chains, cc)
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

// forwardReachableChains returns the chain names a packet entering FORWARD
// can traverse on this device: the primary chain plus everything its jump
// rules descend into.
func forwardReachableChains(rs []CompiledRule, primary string) map[string]bool {
	reach := map[string]bool{primary: true}
	for changed := true; changed; {
		changed = false
		for _, r := range rs {
			if reach[r.Chain] && r.JumpTo != "" && !reach[r.JumpTo] {
				reach[r.JumpTo] = true
				changed = true
			}
		}
	}
	return reach
}

// keepReachable drops rules of chains FORWARD cannot reach here. A device
// left without rules must be omitted entirely: emitting an empty primary
// chain wired into FORWARD would blackhole traffic this device should never
// have touched.
func (a *deviceAccum) keepReachable(reach map[string]bool) {
	kept := a.rules[:0]
	for _, r := range a.rules {
		if reach[r.Chain] {
			kept = append(kept, r)
		}
	}
	a.rules = kept
}

// pruneJumps drops jump rules whose target chain has no rules on this
// device, repeating until stable so nested jumps unwind too. Such a jump
// would evaluate transit traffic against an empty chain and hand it the
// chain's default action — changing policy for flows none of the chain's
// rules were written for.
func (a *deviceAccum) pruneJumps() {
	for {
		content := make(map[string]bool)
		for _, r := range a.rules {
			content[r.Chain] = true
		}
		kept := a.rules[:0]
		removed := false
		for _, r := range a.rules {
			if r.JumpTo != "" && !content[r.JumpTo] {
				removed = true
				continue
			}
			kept = append(kept, r)
		}
		a.rules = kept
		if !removed {
			return
		}
	}
}

// pruneIPSets drops ipset references no surviving rule uses anymore (e.g.
// left behind by pruneJumps).
func (a *deviceAccum) pruneIPSets() {
	used := make(map[string]bool)
	for _, r := range a.rules {
		used[r.SrcSet] = true
		used[r.DstSet] = true
	}
	out := a.ips[:0]
	for _, s := range a.ips {
		if used[s.Name] {
			out = append(out, s)
		}
	}
	a.ips = out
}

func ruleKey(r CompiledRule) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%s|%v|%v|%s|%s", r.Chain, r.SrcSet, r.DstSet, r.SrcAddr, r.DstAddr, r.Proto, r.SrcPorts, r.DstPorts, r.Action, r.JumpTo)
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

func subnetNames(topo *topology.Topology) []string {
	out := make([]string, 0, len(topo.Subnets))
	for name := range topo.Subnets {
		out = append(out, name)
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
	allSubnets := subnetNames(topo)
	accum := make(map[string]*deviceAccum, len(allRouters))
	for _, r := range allRouters {
		accum[r] = &deviceAccum{}
	}

	pairCache := make(map[pairKey][]string)
	names := newIPSetNamer()

	for ci := range pol.Chains {
		c := &pol.Chains[ci]
		for _, rule := range c.Rules {
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
				if (srcAny && dstAny) ||
					(!srcAny && srcLit != nil && len(srcSubnets) == 0) ||
					(!dstAny && dstLit != nil && len(dstSubnets) == 0) {
					// Both sides unbounded, or a literal outside every
					// declared subnet: pathfinding can't tell which routers
					// are relevant, so place on all of them. This is
					// conservative: possibly a few extra devices, never a gap.
					targets = allRouters
				} else {
					// A bounded side keeps its resolved subnets; an any-side
					// expands to every declared subnet — the rule then places
					// exactly where some real src→dst flow transits.
					srcs, dsts := srcSubnets, dstSubnets
					if srcAny {
						srcs = allSubnets
					}
					if dstAny {
						dsts = allSubnets
					}
					routerSet := make(map[string]struct{})
					for _, s := range srcs {
						for _, d := range dsts {
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
					JumpTo:   ar.JumpTo,
					Chain:    c.Name,
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
	}

	defaults := make(map[string]CompiledChain, len(pol.Chains))
	for ci := range pol.Chains {
		c := &pol.Chains[ci]
		defaults[c.Name] = CompiledChain{Name: c.Name, Primary: ci == 0, Position: c.ChainPosition, Default: c.DefaultAction}
	}

	result := make([]DeviceRuleset, 0, len(allRouters))
	for _, name := range allRouters {
		a := accum[name]
		a.pruneJumps()
		a.pruneIPSets()
		if len(a.rules) == 0 {
			continue
		}
		reach := forwardReachableChains(a.rules, pol.Chains[0].Name)
		a.keepReachable(reach)
		if len(a.rules) == 0 {
			continue
		}
		for n := range reach {
			a.ensureChain(n, defaults[n])
		}
		sort.SliceStable(a.chains, func(i, j int) bool {
			if a.chains[i].Primary != a.chains[j].Primary {
				return a.chains[i].Primary
			}
			return a.chains[i].Name < a.chains[j].Name
		})
		result = append(result, DeviceRuleset{
			Device: name,
			IPSets: a.ipsetList(topo),
			Chains: a.chains,
			Rules:  a.rules,
		})
	}
	return result, nil
}
