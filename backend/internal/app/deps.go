package app

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// DeletionErrors diffs the currently stored topology (prev) against a
// proposed one (next) and returns one human-readable message for every
// removed object that is still referenced — by the proposed topology or by
// the filtering rules. An empty result means the deletions are safe.
func DeletionErrors(prev, next *topology.Topology, pol *rules.Policy) []string {
	var errs []string

	for _, name := range missingNames(prev.Subnets, next.Subnets) {
		var deps []string
		for _, nn := range sortedNetworks(next.Networks) {
			if slices.Contains(next.Networks[nn].Subnets, name) {
				deps = append(deps, fmt.Sprintf("network %q", nn))
			}
		}
		for _, sn := range sortedSets(next.Sets) {
			if slices.Contains(next.Sets[sn].Subnets, name) {
				deps = append(deps, fmt.Sprintf("set %q", sn))
			}
		}
		deps = append(deps, ruleDeps(pol, name)...)
		if len(deps) > 0 {
			errs = append(errs, fmt.Sprintf("subnet %q is still used by %s", name, strings.Join(deps, ", ")))
		}
	}

	for _, name := range missingNames(prev.Networks, next.Networks) {
		var deps []string
		for _, sn := range sortedKeys(next.Unions) {
			if slices.Contains(next.Unions[sn].Networks, name) {
				deps = append(deps, fmt.Sprintf("union %q", sn))
			}
		}
		deps = append(deps, ruleDeps(pol, name)...)
		if len(deps) > 0 {
			errs = append(errs, fmt.Sprintf("network %q is still used by %s", name, strings.Join(deps, ", ")))
		}
	}

	for _, name := range missingNames(prev.Sets, next.Sets) {
		if deps := ruleDeps(pol, name); len(deps) > 0 {
			errs = append(errs, fmt.Sprintf("set %q is still used by %s", name, strings.Join(deps, ", ")))
		}
	}

	for _, name := range missingNames(prev.Devices, next.Devices) {
		var deps []string
		for i, l := range next.Links {
			if l.A.Device == name || l.B.Device == name {
				deps = append(deps, fmt.Sprintf("link[%d]", i))
			}
		}
		for _, nn := range sortedNetworks(next.Networks) {
			if slices.ContainsFunc(next.Networks[nn].Attach, func(a topology.Endpoint) bool { return a.Device == name }) {
				deps = append(deps, fmt.Sprintf("network %q", nn))
			}
		}
		for _, sn := range sortedKeys(next.Unions) {
			if slices.Contains(next.Unions[sn].Devices, name) {
				deps = append(deps, fmt.Sprintf("union %q", sn))
			}
		}
		if len(deps) > 0 {
			errs = append(errs, fmt.Sprintf("device %q is still used by %s", name, strings.Join(deps, ", ")))
		}
	}

	return errs
}

// ruleDeps returns the names of rules whose src/dst reference name.
func ruleDeps(pol *rules.Policy, name string) []string {
	if pol == nil {
		return nil
	}
	var out []string
	for _, c := range pol.Chains {
		for _, r := range c.Rules {
			if slices.Contains(r.Src, name) || slices.Contains(r.Dst, name) {
				out = append(out, fmt.Sprintf("rule %q", r.Name))
			}
		}
	}
	return out
}

// missingNames returns prev's keys absent from next, sorted.
func missingNames[T any](prev, next map[string]T) []string {
	var out []string
	for name := range prev {
		if _, ok := next[name]; !ok {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func sortedNetworks(m map[string]topology.Network) []string { return sortedKeys(m) }
func sortedSets(m map[string]topology.Set) []string         { return sortedKeys(m) }

func sortedKeys[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
