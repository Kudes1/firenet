package lint

import (
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// ruleSpan is a rule's src/dst/port match space resolved to merged,
// sorted interval lists, computed once per rule so pairwise comparisons
// across a chain don't re-resolve names for every pair.
type ruleSpan struct {
	src, dst, srcPorts, dstPorts []interval
	proto                        rules.Proto
}

func ruleSpanOf(topo *topology.Topology, r rules.Rule) ruleSpan {
	return ruleSpan{
		src:      mergeIntervals(flattenEndpoints(topo, r.Src)),
		dst:      mergeIntervals(flattenEndpoints(topo, r.Dst)),
		srcPorts: mergeIntervals(portIntervals(r.SrcPorts)),
		dstPorts: mergeIntervals(portIntervals(r.DstPorts)),
		proto:    r.Proto,
	}
}

func ruleSpansOf(topo *topology.Topology, rs []rules.Rule) []ruleSpan {
	out := make([]ruleSpan, len(rs))
	for i, r := range rs {
		out[i] = ruleSpanOf(topo, r)
	}
	return out
}

func flattenEndpoints(topo *topology.Topology, names []string) []interval {
	var out []interval
	for _, n := range names {
		out = append(out, endpointIntervals(topo, n)...)
	}
	return out
}

// spansOverlap reports whether a and b can match at least one common
// packet.
func spansOverlap(a, b ruleSpan) bool {
	return protoOverlaps(a.proto, b.proto) &&
		intervalsOverlap(a.src, b.src) &&
		intervalsOverlap(a.dst, b.dst) &&
		intervalsOverlap(a.srcPorts, b.srcPorts) &&
		intervalsOverlap(a.dstPorts, b.dstPorts)
}

// spanCovers reports whether every packet b can match, a also matches —
// i.e. a fully shadows b when a is evaluated first.
func spanCovers(a, b ruleSpan) bool {
	return protoCovers(a.proto, b.proto) &&
		intervalsCover(a.src, b.src) &&
		intervalsCover(a.dst, b.dst) &&
		intervalsCover(a.srcPorts, b.srcPorts) &&
		intervalsCover(a.dstPorts, b.dstPorts)
}

func protoOverlaps(a, b rules.Proto) bool {
	return a == rules.ProtoAny || b == rules.ProtoAny || a == b
}

func protoCovers(a, b rules.Proto) bool {
	return a == rules.ProtoAny || a == b
}
