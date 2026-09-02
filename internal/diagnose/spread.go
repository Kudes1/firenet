package diagnose

import (
	"fmt"
	"net/netip"
	"sort"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

type netipPrefix = netip.Prefix

func mustAddr(s string) netip.Addr {
	a, err := netip.ParseAddr(s)
	if err != nil {
		panic("diagnose: invalid representative address " + s)
	}
	return a
}

// Source is one resolved spread origin: the representative IP to diagnose
// from and, when the input named a subnet, that subnet (its own candidacy
// is skipped and it counts as trivially reachable).
type Source struct {
	IP         string
	SubnetName string
}

// SpreadOptions describes the "network propagation" query: from where
// (Input: subnet name, network name, or literal IP) and with which traffic
// filter (empty = any).
type SpreadOptions struct {
	Input    string
	Proto    rules.Proto
	DstPorts []string
}

// CandidateReport is one per-candidate result: the candidate subnet (the
// potential peer of the inspected network) and its diagnose report.
type CandidateReport struct {
	Candidate string  `json:"candidate"`
	Report    *Report `json:"report"`
}

// Spread is the aggregated propagation answer: one report per candidate
// subnet plus the merged map mark for the whole picture.
type SpreadResult struct {
	Sources []Source          `json:"sources"`
	Reports []CandidateReport `json:"reports"`
	Mark    *MapMark          `json:"mark"`
}

// ResolveSources maps spread input to sources: an exact subnet name to its
// base IP, a network name to every member subnet's base IP, anything else
// to a literal IP (validated at the HTTP boundary).
func ResolveSources(topo *topology.Topology, input string) ([]Source, error) {
	if s, ok := topo.Subnets[input]; ok {
		return []Source{{IP: baseIP(s.CIDR), SubnetName: input}}, nil
	}
	if n, ok := topo.Networks[input]; ok {
		names := append([]string(nil), n.Subnets...)
		sort.Strings(names)
		out := make([]Source, 0, len(names))
		for _, sn := range names {
			s, ok := topo.Subnets[sn]
			if !ok {
				return nil, fmt.Errorf("сеть %s ссылается на неизвестную подсеть %s", input, sn)
			}
			out = append(out, Source{IP: baseIP(s.CIDR), SubnetName: sn})
		}
		return out, nil
	}
	// Not a subnet or network name: a literal IP, validated here so the
	// error surfaces at resolve time.
	if _, err := netip.ParseAddr(input); err != nil {
		return nil, fmt.Errorf("%q — не подсеть, не сеть и не IP-адрес", input)
	}
	return []Source{{IP: input, SubnetName: ""}}, nil
}
func baseIP(p netipPrefix) string { return p.Addr().String() }

// Spread answers "where does this network already propagate to": for every
// subnet other than the inspected sources it runs the diagnose (candidate →
// source, request direction — the tool shows who can already reach the
// inspected network) and merges the per-pair map marks into one picture.
// Reachability is a routing question: a denied path still counts as
// "reached" in the reports; the firewall verdicts live in the mark.
func Spread(topo *topology.Topology, sets []compiler.DeviceRuleset, g *graph.Graph, limits graph.Limits, opts SpreadOptions) (*SpreadResult, error) {
	sources, err := ResolveSources(topo, opts.Input)
	if err != nil {
		return nil, fmt.Errorf("источник: %w", err)
	}
	selfNames := make(map[string]bool, len(sources))
	for _, s := range sources {
		if s.SubnetName != "" {
			selfNames[s.SubnetName] = true
		}
	}

	candidates := make([]string, 0, len(topo.Subnets))
	for name := range topo.Subnets {
		if !selfNames[name] {
			candidates = append(candidates, name)
		}
	}
	sort.Strings(candidates)

	sp := &SpreadResult{
		Sources: sources,
		Reports: []CandidateReport{},
	}
	var marks []*MapMark
	for _, cand := range candidates {
		for _, src := range sources {
			flow := Flow{
				Src:      mustAddr(baseIP(topo.Subnets[cand].CIDR)),
				Dst:      mustAddr(src.IP),
				Proto:    opts.Proto,
				DstPorts: opts.DstPorts,
			}
			rep, err := Run(topo, sets, g, limits, flow)
			if err != nil {
				return nil, fmt.Errorf("кандидат %s: %w", cand, err)
			}
			sp.Reports = append(sp.Reports, CandidateReport{Candidate: cand, Report: rep})
			marks = append(marks, rep.MapMark)
		}
	}
	sp.Mark = MergeMarks(marks)
	// The inspected sources themselves are trivially reachable and lit
	// (mirroring the frontend: their owning networks go into hl and ok).
	anchor := anchorOf(topo)
	for _, src := range sources {
		if src.SubnetName == "" {
			continue
		}
		if a := anchor(graph.SubnetNode(src.SubnetName)); a != "" {
			sp.Mark.addHL(bare(a))
			sp.Mark.addOk(bare(a))
		}
	}
	return sp, nil
}
