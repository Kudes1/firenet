package compiler

import (
	"fmt"
	"hash/crc32"
	"sort"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// atomicRule is a Rule with its OR-list Src/Dst expanded to a single name
// each, so every atomic rule maps to at most one ipset per side.
type atomicRule struct {
	RuleName string
	Src, Dst string
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
	Action   rules.Action
}

func expandAtomic(r rules.Rule) []atomicRule {
	out := make([]atomicRule, 0, len(r.Src)*len(r.Dst))
	for _, s := range r.Src {
		for _, d := range r.Dst {
			out = append(out, atomicRule{RuleName: r.Name, Src: s, Dst: d, Proto: r.Proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts, Action: r.Action})
			if r.Mirror {
				// Direction reverses, so what matched as the dst port now
				// matches as the src port, and vice versa.
				out = append(out, atomicRule{RuleName: r.Name, Src: d, Dst: s, Proto: r.Proto, SrcPorts: r.DstPorts, DstPorts: r.SrcPorts, Action: r.Action})
			}
		}
	}
	return out
}

type pairKey struct{ src, dst string }

type deviceAccum struct {
	rules      []CompiledRule
	ipsetNames map[string]struct{}
}

func (a *deviceAccum) addIPSetRef(name string) {
	if a.ipsetNames == nil {
		a.ipsetNames = make(map[string]struct{})
	}
	a.ipsetNames[name] = struct{}{}
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
	return fmt.Sprintf("%s|%s|%s|%v|%v|%s", r.SrcSet, r.DstSet, r.Proto, r.SrcPorts, r.DstPorts, r.Action)
}

func (a *deviceAccum) ipsetList(topo *topology.Topology) []IPSet {
	names := make([]string, 0, len(a.ipsetNames))
	for n := range a.ipsetNames {
		names = append(names, n)
	}
	sort.Strings(names)

	out := make([]IPSet, 0, len(names))
	for _, n := range names {
		subnets, _ := topo.ResolveZone(n) // already validated to succeed
		cidrs := make([]string, 0, len(subnets))
		for _, s := range subnets {
			cidrs = append(cidrs, topo.Subnets[s].CIDR.String())
		}
		sort.Strings(cidrs)
		out = append(out, IPSet{Name: ipsetName(n), DisplayName: n, CIDRs: cidrs})
	}
	return out
}

func ipsetName(entity string) string {
	return fmt.Sprintf("fn_%08x", crc32.ChecksumIEEE([]byte(entity)))
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
// physically need each rule, and returns one ruleset per managed router
// (routers with no applicable rule still get the conntrack/default-action
// baseline via DefaultAction, rendered by internal/render).
func Compile(topo *topology.Topology, pol *rules.Policy, g *graph.Graph, limits graph.Limits) ([]DeviceRuleset, error) {
	allRouters := routerNames(topo)
	accum := make(map[string]*deviceAccum, len(allRouters))
	for _, r := range allRouters {
		accum[r] = &deviceAccum{}
	}

	pairCache := make(map[pairKey][]string)

	for _, rule := range pol.Rules {
		for _, ar := range expandAtomic(rule) {
			srcAny := ar.Src == rules.Any
			dstAny := ar.Dst == rules.Any

			var srcSubnets, dstSubnets []string
			var err error
			if !srcAny {
				if srcSubnets, err = topo.ResolveZone(ar.Src); err != nil {
					return nil, fmt.Errorf("rule %q: src %q: %w", rule.Name, ar.Src, err)
				}
			}
			if !dstAny {
				if dstSubnets, err = topo.ResolveZone(ar.Dst); err != nil {
					return nil, fmt.Errorf("rule %q: dst %q: %w", rule.Name, ar.Dst, err)
				}
			}

			var targets []string
			if srcAny || dstAny {
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
				Comment:  ar.RuleName,
				Proto:    ar.Proto,
				SrcPorts: ar.SrcPorts,
				DstPorts: ar.DstPorts,
				Action:   ar.Action,
			}
			if !srcAny {
				compiled.SrcSet = ipsetName(ar.Src)
			}
			if !dstAny {
				compiled.DstSet = ipsetName(ar.Dst)
			}

			for _, target := range targets {
				a := accum[target]
				a.addRule(compiled)
				if !srcAny {
					a.addIPSetRef(ar.Src)
				}
				if !dstAny {
					a.addIPSetRef(ar.Dst)
				}
			}
		}
	}

	result := make([]DeviceRuleset, 0, len(allRouters))
	for _, name := range allRouters {
		a := accum[name]
		result = append(result, DeviceRuleset{
			Device:        name,
			IPSets:        a.ipsetList(topo),
			Rules:         a.rules,
			DefaultAction: pol.DefaultAction,
		})
	}
	return result, nil
}
