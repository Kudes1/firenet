package lint

import (
	"fmt"
	"slices"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// checkDeadChains flags a non-primary chain that no rule ever jumps to.
func checkDeadChains(pol *rules.Policy) []Finding {
	referenced := make(map[string]bool)
	for _, c := range pol.Chains {
		for _, r := range c.Rules {
			if r.Action == rules.ActionJump {
				referenced[r.JumpTo] = true
			}
		}
	}
	var out []Finding
	for i, c := range pol.Chains {
		if i == 0 || referenced[c.Name] {
			continue
		}
		out = append(out, Finding{
			Severity: SeverityWarning,
			Chain:    c.Name,
			Message:  fmt.Sprintf("цепочка %q не используется — на неё нет ни одного jump", c.Name),
		})
	}
	return out
}

// checkMirror flags two symmetry issues: a mirror flag that adds nothing
// because src/dst already overlap, and two separate rules that manually
// implement what one mirrored rule would do.
func checkMirror(pol *rules.Policy, topo *topology.Topology) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		spans := ruleSpansOf(topo, c.Rules)
		for i, r := range c.Rules {
			if r.Mirror && intervalsOverlap(spans[i].src, spans[i].dst) {
				out = append(out, Finding{
					Severity: SeverityInfo,
					Chain:    c.Name,
					Rules:    []string{r.Name},
					Message:  fmt.Sprintf("правило %q: src и dst уже пересекаются — mirror не добавляет новых пар", r.Name),
				})
			}
		}
		for i := 0; i < len(c.Rules); i++ {
			a := c.Rules[i]
			if a.Mirror {
				continue
			}
			for j := i + 1; j < len(c.Rules); j++ {
				b := c.Rules[j]
				if b.Mirror || a.Proto != b.Proto || a.Action != b.Action {
					continue
				}
				if isExactMirrorPair(spans[i], spans[j]) {
					out = append(out, Finding{
						Severity: SeverityInfo,
						Chain:    c.Name,
						Rules:    []string{a.Name, b.Name},
						Message:  fmt.Sprintf("правила %q и %q — точные зеркала друг друга; можно объединить в одно с mirror: true", a.Name, b.Name),
					})
				}
			}
		}
	}
	return out
}

// isExactMirrorPair reports whether b is exactly what compiling a with
// mirror: true would additionally produce — src/dst swapped and, since
// the traffic direction reverses, srcPorts/dstPorts swapped too (see
// internal/compiler/compiler.go: expandAtomic).
func isExactMirrorPair(a, b ruleSpan) bool {
	return slices.Equal(a.src, b.dst) && slices.Equal(a.dst, b.src) &&
		slices.Equal(a.srcPorts, b.dstPorts) && slices.Equal(a.dstPorts, b.srcPorts)
}

// checkBroadAnyRule flags an any→any, proto-any rule with no comment —
// likely intentional, but worth a nudge to document the intent.
func checkBroadAnyRule(pol *rules.Policy) []Finding {
	var out []Finding
	for _, c := range pol.Chains {
		for _, r := range c.Rules {
			if r.Comment != "" {
				continue
			}
			if len(r.Src) == 1 && r.Src[0] == rules.Any && len(r.Dst) == 1 && r.Dst[0] == rules.Any && r.Proto == rules.ProtoAny {
				out = append(out, Finding{
					Severity: SeverityInfo,
					Chain:    c.Name,
					Rules:    []string{r.Name},
					Message:  fmt.Sprintf("правило %q разрешает/запрещает весь трафик (any→any, proto any) без комментария — стоит пояснить назначение", r.Name),
				})
			}
		}
	}
	return out
}
