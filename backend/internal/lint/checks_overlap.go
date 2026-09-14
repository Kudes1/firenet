package lint

import (
	"fmt"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// checkUnreachable flags a rule that can never fire because an earlier
// rule in the same chain already fully covers its match space — the
// earlier rule decides the outcome first, regardless of what action the
// later rule declares. Only the first (nearest) covering predecessor is
// reported per rule.
func checkUnreachable(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for j := 1; j < len(c.Rules); j++ {
			for i := 0; i < j; i++ {
				if !spanCovers(spans[i], spans[j]) {
					continue
				}
				var msg string
				if c.Rules[i].Action == c.Rules[j].Action {
					msg = fmt.Sprintf("правило %q никогда не применяется — более раннее правило %q уже покрывает весь его трафик с тем же действием", c.Rules[j].Name, c.Rules[i].Name)
				} else {
					msg = fmt.Sprintf("правило %q никогда не применяется — более раннее правило %q решает исход первым (action=%s)", c.Rules[j].Name, c.Rules[i].Name, c.Rules[i].Action)
				}
				out = append(out, Finding{
					Severity: SeverityWarning,
					Chain:    c.Name,
					Rules:    []string{c.Rules[i].Name, c.Rules[j].Name},
					Message:  msg,
				})
				break
			}
		}
	}
	return out
}

// checkConflict flags two rules in the same chain that partially overlap
// (neither fully covers the other — that's checkUnreachable's job) but
// declare different actions, so the outcome for the overlapping subset
// of traffic depends on which one is evaluated first.
func checkConflict(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for i := range c.Rules {
			for j := i + 1; j < len(c.Rules); j++ {
				if c.Rules[i].Action == c.Rules[j].Action {
					continue
				}
				if !spansOverlap(spans[i], spans[j]) {
					continue
				}
				if spanCovers(spans[i], spans[j]) || spanCovers(spans[j], spans[i]) {
					continue
				}
				out = append(out, Finding{
					Severity: SeverityWarning,
					Chain:    c.Name,
					Rules:    []string{c.Rules[i].Name, c.Rules[j].Name},
					Message: fmt.Sprintf("правила %q и %q частично пересекаются с разными action (%s/%s) — для общего трафика решает порядок правил",
						c.Rules[i].Name, c.Rules[j].Name, c.Rules[i].Action, c.Rules[j].Action),
				})
			}
		}
	}
	return out
}
