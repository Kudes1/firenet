package lint

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// anyIPInterval is the sentinel span for the rules.Any ("any") endpoint —
// the whole IPv4 address space. IPv6 isn't supported anywhere else in
// this project either (see topology.ParseEndpointPrefix), so IPv4's
// 32-bit space is the entire domain here.
var anyIPInterval = interval{lo: 0, hi: 0xFFFFFFFF}

// anyPortInterval is the sentinel span for an empty port list ("any port").
var anyPortInterval = interval{lo: 0, hi: 65535}

// endpointIntervals resolves one rule src/dst entry to the IPv4 ranges it
// matches, in the same name-resolution order as rules.validEndpoint:
// "any", subnet, network, set, else a literal address/CIDR. topo must
// already be valid (topology.Validate) — see Check's precondition.
// Non-IPv4 CIDRs (topologically possible via a hand-written subnets.yaml
// entry, even though the project has no IPv6 support in practice) are
// skipped rather than causing a crash.
func endpointIntervals(topo *topology.Topology, name string) []interval {
	if name == rules.Any {
		return []interval{anyIPInterval}
	}
	_, isSet := topo.Sets[name]
	_, isSubnet := topo.Subnets[name]
	_, isNetwork := topo.Networks[name]
	if isSet || isSubnet || isNetwork {
		var out []interval
		for _, c := range topo.EntityCIDRs(name) {
			p, err := netip.ParsePrefix(c)
			if err != nil || !p.Addr().Is4() {
				continue
			}
			out = append(out, prefixInterval(p))
		}
		return out
	}
	if p, ok := topology.ParseEndpointPrefix(name); ok {
		return []interval{prefixInterval(p)}
	}
	return nil
}

// prefixInterval converts an IPv4 prefix to its inclusive address range.
func prefixInterval(p netip.Prefix) interval {
	p = p.Masked()
	b := p.Addr().As4()
	lo := uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
	span := uint64(1) << (32 - p.Bits())
	return interval{lo: lo, hi: lo + span - 1}
}

// portIntervals resolves a rule's SrcPorts/DstPorts (dash-separated, e.g.
// "80" or "1000-2000" — rules.Rule's own syntax, validated by
// rules.validatePortSpec) to the port ranges they match. An empty list
// means "any port".
func portIntervals(specs []string) []interval {
	if len(specs) == 0 {
		return []interval{anyPortInterval}
	}
	out := make([]interval, 0, len(specs))
	for _, spec := range specs {
		lo, hi, ok := parsePortSpec(spec)
		if !ok {
			continue // Check's precondition guarantees pol.Validate(topo) already passed
		}
		out = append(out, interval{lo: uint64(lo), hi: uint64(hi)})
	}
	return out
}

func parsePortSpec(spec string) (lo, hi int, ok bool) {
	loStr, hiStr, ranged := strings.Cut(spec, "-")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	if err1 != nil || err2 != nil || lo < 1 || hi > 65535 || lo > hi {
		return 0, 0, false
	}
	return lo, hi, true
}
