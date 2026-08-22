package rules

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/topology"
)

// Filters holds per-column search criteria; an empty field means no
// constraint on that column.
type Filters struct {
	Name, Comment, Src, Dst, Proto, SrcPorts, DstPorts, Action string
}

// FilterRules keeps the rules matching every non-empty filter (AND).
// Src/Dst accept endpoint name substrings or IP/CIDR values; an IP matches
// a rule when any of its endpoints resolves to a subnet containing it, and
// the "any" endpoint matches every address.
func FilterRules(rules []Rule, f Filters, topo *topology.Topology) []Rule {
	out := make([]Rule, 0, len(rules))
	for _, r := range rules {
		if matchRule(r, f, topo) {
			out = append(out, r)
		}
	}
	return out
}

func matchRule(r Rule, f Filters, topo *topology.Topology) bool {
	return containsFold(r.Name, f.Name) &&
		containsFold(r.Comment, f.Comment) &&
		containsFold(string(r.Proto), f.Proto) &&
		containsFold(strings.Join(r.SrcPorts, ","), f.SrcPorts) &&
		containsFold(strings.Join(r.DstPorts, ","), f.DstPorts) &&
		containsFold(string(r.Action), f.Action) &&
		matchEndpoints(r.Src, f.Src, topo) &&
		matchEndpoints(r.Dst, f.Dst, topo)
}

func containsFold(s, sub string) bool {
	return sub == "" || strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func matchEndpoints(names []string, q string, topo *topology.Topology) bool {
	if q == "" {
		return true
	}
	if addr, err := netip.ParseAddr(q); err == nil {
		return matchByAddr(names, topo, func(p netip.Prefix) bool { return p.Contains(addr) })
	}
	if prefix, err := netip.ParsePrefix(q); err == nil {
		return matchByAddr(names, topo, func(p netip.Prefix) bool { return p.Overlaps(prefix) })
	}
	if prefix, ok := partialIPv4Prefix(q); ok {
		return matchByAddr(names, topo, func(p netip.Prefix) bool { return p.Overlaps(prefix) })
	}
	for _, n := range names {
		if containsFold(n, q) {
			return true
		}
	}
	return false
}

// partialIPv4Prefix turns a partially typed IPv4 address ("10.", "10.0",
// "10.0.0") into the CIDR block implied by the octets typed so far
// (10.0.0.0/8 etc.), so search matches before the full address is entered.
func partialIPv4Prefix(q string) (netip.Prefix, bool) {
	parts := strings.Split(q, ".")
	if len(parts) > 4 || parts[0] == "" {
		return netip.Prefix{}, false
	}
	if parts[len(parts)-1] == "" { // trailing dot
		parts = parts[:len(parts)-1]
	}
	octets := make([]string, 0, 4)
	for _, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || v > 255 || strings.HasPrefix(p, "0") && len(p) > 1 {
			return netip.Prefix{}, false
		}
		octets = append(octets, p)
	}
	for len(octets) < 4 {
		octets = append(octets, "0")
	}
	prefix, err := netip.ParsePrefix(strings.Join(octets, ".") + "/" + strconv.Itoa(len(parts)*8))
	return prefix, err == nil
}

func matchByAddr(names []string, topo *topology.Topology, hit func(netip.Prefix) bool) bool {
	for _, n := range names {
		if n == Any {
			return true
		}
		if p, ok := topology.ParseEndpointPrefix(n); ok {
			// A literally written endpoint matches by its own CIDR.
			if hit(p) {
				return true
			}
			continue
		}
		subs, err := topo.ResolveNetwork(n)
		if err != nil {
			continue
		}
		for _, s := range subs {
			if hit(topo.Subnets[s].CIDR) {
				return true
			}
		}
	}
	return false
}
