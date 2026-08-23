package compiler

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/rules"
)

// MatchFlow returns the first CompiledRule of rs matching a packet from src
// to dst — the same first-match order the rendered iptables script evaluates
// in. nil means no rule matches and traffic falls to rs.DefaultAction.
// Semantics mirror render exactly: empty set/literal side is unconditional;
// an ipset matches when any of its CIDRs contains the address; a rule with
// ProtoAny matches every protocol, otherwise the flow proto must be set and
// equal to the rule proto; a rule without ports matches any port, otherwise
// some flow port must intersect a rule entry ("a:b" ranges overlap numerically).
func MatchFlow(rs DeviceRuleset, src, dst netip.Addr, proto rules.Proto, srcPorts, dstPorts []string) *CompiledRule {
	for i := range rs.Rules {
		r := &rs.Rules[i]
		if !sideMatches(rs, r.SrcSet, r.SrcAddr, src) || !sideMatches(rs, r.DstSet, r.DstAddr, dst) {
			continue
		}
		if r.Proto != rules.ProtoAny && r.Proto != proto {
			continue
		}
		if !portsMatch(r.SrcPorts, srcPorts) || !portsMatch(r.DstPorts, dstPorts) {
			continue
		}
		return r
	}
	return nil
}

func sideMatches(rs DeviceRuleset, set, literal string, addr netip.Addr) bool {
	switch {
	case set != "":
		return setContains(rs, set, addr)
	case literal != "":
		p, err := netip.ParsePrefix(literal)
		return err == nil && p.Contains(addr)
	default:
		return true
	}
}

func setContains(rs DeviceRuleset, name string, addr netip.Addr) bool {
	for _, s := range rs.IPSets {
		if s.Name != name {
			continue
		}
		for _, c := range s.CIDRs {
			if p, err := netip.ParsePrefix(c); err == nil && p.Contains(addr) {
				return true
			}
		}
		return false
	}
	return false
}

func portsMatch(rulePorts, flowPorts []string) bool {
	if len(rulePorts) == 0 {
		return true
	}
	if len(flowPorts) == 0 {
		return false
	}
	for _, rp := range rulePorts {
		for _, fp := range flowPorts {
			if portOverlap(rp, fp) {
				return true
			}
		}
	}
	return false
}

func portOverlap(a, b string) bool {
	al, ah, ok := portRange(a)
	if !ok {
		return false
	}
	bl, bh, ok := portRange(b)
	if !ok {
		return false
	}
	return al <= bh && bl <= ah
}

func portRange(s string) (lo, hi int, ok bool) {
	loStr, hiStr, ranged := strings.Cut(s, ":")
	if !ranged {
		hiStr = loStr
	}
	lo, err1 := strconv.Atoi(loStr)
	hi, err2 := strconv.Atoi(hiStr)
	if err1 != nil || err2 != nil || lo > hi {
		return 0, 0, false
	}
	return lo, hi, true
}
