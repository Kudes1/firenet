package pgstore

import (
	"bytes"
	"encoding/json"
	"reflect"
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

// jsonEqual compares two JSON documents semantically rather than
// byte-for-byte: Postgres's JSONB re-serializes (alphabetical key order,
// different whitespace) on the way back out of storage, while Go's
// json.Marshal preserves struct field declaration order, so two
// semantically identical values can differ byte-for-byte after a round
// trip through the database.
func jsonEqual(a, b json.RawMessage) bool {
	if bytes.Equal(a, b) {
		return true
	}
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		return false
	}
	return reflect.DeepEqual(av, bv)
}

// diffSnapshots reports every entity that differs between before and
// after, sorted by (Kind, Key). Entities present in both with
// semantically equal data are omitted.
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
		case hasBefore && hasAfter && !jsonEqual(b.Data, a.Data):
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
