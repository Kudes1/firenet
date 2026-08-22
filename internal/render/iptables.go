// Package render turns a compiled DeviceRuleset into the text scripts a
// device needs: an ipset-restore file and an iptables setup script. It knows
// nothing about YAML, files, or the CLI.
package render

import (
	"fmt"
	"sort"
	"strings"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/rules"
)

// RenderIPSets renders an `ipset restore`-compatible script for a device.
func RenderIPSets(ds compiler.DeviceRuleset) []byte {
	var b strings.Builder
	for _, set := range ds.IPSets {
		fmt.Fprintf(&b, "create %s hash:net -exist\n", set.Name)
		cidrs := append([]string(nil), set.CIDRs...)
		sort.Strings(cidrs)
		for _, cidr := range cidrs {
			fmt.Fprintf(&b, "add %s %s\n", set.Name, cidr)
		}
	}
	return []byte(b.String())
}

// RenderRules renders an idempotent shell script that creates (if absent)
// and fully owns ds.ChainName, wires its jump into FORWARD at ds.ChainPosition,
// then repopulates the chain: conntrack accept first, then the compiled
// rules in order, then the policy default.
//
// The jump is deleted and re-inserted on every run (rather than left alone
// once present) so that changing ChainName or ChainPosition actually takes
// effect the next time this script runs, instead of leaving a stale jump
// from a previous configuration in place.
func RenderRules(ds compiler.DeviceRuleset) []byte {
	chain := ds.ChainName
	var b strings.Builder
	fmt.Fprint(&b, "#!/bin/sh\nset -e\n")
	fmt.Fprintf(&b, "iptables -N %s 2>/dev/null || true\n", chain)
	fmt.Fprintf(&b, "while iptables -C FORWARD -j %s 2>/dev/null; do iptables -D FORWARD -j %s; done\n", chain, chain)
	if ds.ChainPosition == rules.ChainBottom {
		fmt.Fprintf(&b, "iptables -A FORWARD -j %s\n", chain)
	} else {
		fmt.Fprintf(&b, "iptables -I FORWARD -j %s\n", chain)
	}
	fmt.Fprintf(&b, "iptables -F %s\n", chain)
	fmt.Fprintf(&b, "iptables -A %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n", chain)

	for _, r := range ds.Rules {
		fmt.Fprintf(&b, "iptables -A %s %s-j %s\n", chain, matchArgs(r), actionTarget(r.Action))
	}

	fmt.Fprintf(&b, "iptables -A %s -j %s\n", chain, actionTarget(ds.DefaultAction))
	return []byte(b.String())
}

func matchArgs(r compiler.CompiledRule) string {
	var parts []string
	if r.SrcSet != "" {
		parts = append(parts, fmt.Sprintf("-m set --match-set %s src", r.SrcSet))
	}
	if r.DstSet != "" {
		parts = append(parts, fmt.Sprintf("-m set --match-set %s dst", r.DstSet))
	}
	if r.SrcAddr != "" {
		parts = append(parts, "-s "+r.SrcAddr)
	}
	if r.DstAddr != "" {
		parts = append(parts, "-d "+r.DstAddr)
	}
	if r.Proto != "" && r.Proto != rules.ProtoAny {
		parts = append(parts, fmt.Sprintf("-p %s", r.Proto))
		if len(r.SrcPorts) > 0 {
			parts = append(parts, fmt.Sprintf("-m multiport --sports %s", multiportList(r.SrcPorts)))
		}
		if len(r.DstPorts) > 0 {
			parts = append(parts, fmt.Sprintf("-m multiport --dports %s", multiportList(r.DstPorts)))
		}
	}
	if r.Comment != "" {
		parts = append(parts, fmt.Sprintf("-m comment --comment %q", r.Comment))
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " ") + " "
}

// multiportList renders port specs for the multiport match, where ranges use
// ':' (e.g. "1000:2000") rather than the '-' used in the rules model.
func multiportList(ports []string) string {
	out := make([]string, len(ports))
	for i, p := range ports {
		out[i] = strings.Replace(p, "-", ":", 1)
	}
	return strings.Join(out, ",")
}

func actionTarget(a rules.Action) string {
	if a == rules.ActionAllow {
		return "ACCEPT"
	}
	return "DROP"
}
