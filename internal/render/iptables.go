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

// chainName is firenet's own FORWARD chain. Rules live only here, so
// applying them never touches whatever the device administrator already
// configured directly in FORWARD.
const chainName = "FIRENET-FWD"

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
// and fully owns chainName, then repopulates it: conntrack accept first,
// then the compiled rules in order, then the policy default.
func RenderRules(ds compiler.DeviceRuleset) []byte {
	var b strings.Builder
	fmt.Fprint(&b, "#!/bin/sh\nset -e\n")
	fmt.Fprintf(&b, "iptables -N %s 2>/dev/null || true\n", chainName)
	fmt.Fprintf(&b, "iptables -C FORWARD -j %s 2>/dev/null || iptables -I FORWARD -j %s\n", chainName, chainName)
	fmt.Fprintf(&b, "iptables -F %s\n", chainName)
	fmt.Fprintf(&b, "iptables -A %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n", chainName)

	for _, r := range ds.Rules {
		fmt.Fprintf(&b, "iptables -A %s %s-j %s\n", chainName, matchArgs(r), actionTarget(r.Action))
	}

	fmt.Fprintf(&b, "iptables -A %s -j %s\n", chainName, actionTarget(ds.DefaultAction))
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
	if r.Proto != "" && r.Proto != rules.ProtoAny {
		parts = append(parts, fmt.Sprintf("-p %s", r.Proto))
		if len(r.SrcPorts) > 0 {
			parts = append(parts, fmt.Sprintf("-m multiport --sports %s", strings.Join(r.SrcPorts, ",")))
		}
		if len(r.DstPorts) > 0 {
			parts = append(parts, fmt.Sprintf("-m multiport --dports %s", strings.Join(r.DstPorts, ",")))
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

func actionTarget(a rules.Action) string {
	if a == rules.ActionAllow {
		return "ACCEPT"
	}
	return "DROP"
}
