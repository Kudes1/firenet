package pgstore

import (
	"bytes"
	"encoding/json"
	"sort"
)

// EntityDiff is one entity's change between two snapshots: a version-to-
// version comparison, or a draft compared against its base version.
type EntityDiff struct {
	Kind   string
	Key    string
	Change string          // added|modified|removed
	Before json.RawMessage // nil when Change == "added"
	After  json.RawMessage // nil when Change == "removed"
}

// diffSnapshots reports every entity that differs between before and
// after, sorted by (Kind, Key). Entities present in both with
// byte-identical data are omitted.
func diffSnapshots(before, after map[entityRef]entityRow) []EntityDiff {
	seen := make(map[entityRef]bool, len(before)+len(after))
	for ref := range before {
		seen[ref] = true
	}
	for ref := range after {
		seen[ref] = true
	}

	var out []EntityDiff
	for ref := range seen {
		b, hasBefore := before[ref]
		a, hasAfter := after[ref]
		switch {
		case !hasBefore && hasAfter:
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "added", After: a.Data})
		case hasBefore && !hasAfter:
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "removed", Before: b.Data})
		case hasBefore && hasAfter && !bytes.Equal(b.Data, a.Data):
			out = append(out, EntityDiff{Kind: ref.Kind, Key: ref.Key, Change: "modified", Before: b.Data, After: a.Data})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Key < out[j].Key
	})
	return out
}
