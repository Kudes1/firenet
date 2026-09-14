// Package lint statically analyzes a rules.Policy for likely mistakes —
// unreachable rules, conflicting overlaps, unused chains, and mirror
// redundancy. Every result is advisory: nothing here blocks compiling or
// persisting a policy, and nothing here considers topology routing (see
// internal/diagnose for path-aware analysis of one concrete flow).
package lint

import "sort"

// interval is an inclusive numeric range, used for both IPv4 addresses
// (0..2^32-1) and ports (0..65535).
type interval struct{ lo, hi uint64 }

// mergeIntervals sorts rs by lo and merges ranges that overlap or touch
// (next.lo <= cur.hi+1), so a contiguous span split across several
// entries (e.g. two adjacent /25s, or "80-100" and "101-200" in one
// rule's port list) collapses to one interval. Returns nil for empty
// input.
func mergeIntervals(rs []interval) []interval {
	if len(rs) == 0 {
		return nil
	}
	sorted := append([]interval(nil), rs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].lo < sorted[j].lo })
	out := []interval{sorted[0]}
	for _, r := range sorted[1:] {
		last := &out[len(out)-1]
		if r.lo <= last.hi+1 {
			if r.hi > last.hi {
				last.hi = r.hi
			}
			continue
		}
		out = append(out, r)
	}
	return out
}

// intervalsOverlap reports whether any value is present in both a and b.
// a and b must already be mergeIntervals-clean (sorted, non-overlapping).
func intervalsOverlap(a, b []interval) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i].hi < b[j].lo:
			i++
		case b[j].hi < a[i].lo:
			j++
		default:
			return true
		}
	}
	return false
}

// intervalsCover reports whether every interval in covered lies entirely
// within some single interval of covering. Both must already be
// mergeIntervals-clean. Vacuously true if covered is empty.
func intervalsCover(covering, covered []interval) bool {
	for _, c := range covered {
		found := false
		for _, g := range covering {
			if g.lo <= c.lo && c.hi <= g.hi {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
