// Package lint statically analyzes a rules.Policy for likely mistakes —
// unreachable rules, conflicting overlaps, unused chains, and mirror
// redundancy. Every result is advisory: nothing here blocks compiling or
// persisting a policy, and nothing here considers topology routing (see
// internal/diagnose for path-aware analysis of one concrete flow).
package lint

import (
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// Severity is how strongly a Finding should be surfaced. Neither value
// blocks anything — see the package doc.
type Severity string

const (
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Finding is one static-analysis result.
type Finding struct {
	Severity Severity `json:"severity"`
	Chain    string   `json:"chain"`
	Rules    []string `json:"rules,omitempty"`
	Message  string   `json:"message"`
}

// Check runs every lint pass against pol and returns their findings.
// Findings are grouped by check — unreachable rules, then conflicting
// overlaps, then mirror issues, then overly broad rules, then dead
// chains — and within each check ordered by chain and rule position, so
// results are fully deterministic across runs of the same policy.
//
// pol must already have passed pol.Validate(topo): Check assumes every
// src/dst name resolves and every jump target exists, and does not
// re-validate structure itself.
func Check(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	out = append(out, checkUnreachable(pol, topo)...)
	out = append(out, checkConflict(pol, topo)...)
	out = append(out, checkMirror(pol, topo)...)
	out = append(out, checkBroadAnyRule(pol)...)
	out = append(out, checkDeadChains(pol)...)
	return out
}
