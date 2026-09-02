package diagnose_test

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/rules"
)

// mapmark fixtures reuse the diag* fixtures from diagnose_test.go.

// sortStrings returns a sorted copy for comparing mark sets regardless of
// iteration order.
func sortStrings(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func markOf(t *testing.T, rep *diagnose.Report) *diagnose.MapMark {
	t.Helper()
	if rep.MapMark == nil {
		t.Fatal("report carries no mapMark")
	}
	return rep.MapMark
}

// allowedPathTopology is the plain diagTopology (r1–r2, office/dmz networks).
// Traffic office→dmz lights: both networks, both routers, the r1–r2 link.

func TestMarkMap_AllowedPathLightsWholeRoute(t *testing.T) {
	rep := runDiag(t, diagRulesAllowBothWays, "10.0.0.5", "10.0.1.7", "")
	m := markOf(t, rep)
	want := []string{"n-dmz", "n-office", "r1", "r2"}
	if got := sortStrings(m.Highlight); !slicesEqual(got, want) {
		t.Fatalf("highlight: want %v, got %v", want, got)
	}
	if got := sortStrings(m.Ok); !slicesEqual(got, want) {
		t.Fatalf("ok: want %v, got %v", want, got)
	}
	if len(m.DenyE) != 0 || len(m.Half) != 0 || len(m.HalfE) != 0 || len(m.Deny) != 0 {
		t.Fatalf("allowed both-ways path must be purely green, got %+v", m)
	}
}

func TestMarkMap_EdgeKeysAreCanonical(t *testing.T) {
	rep := runDiag(t, diagRulesAllowBothWays, "10.0.0.5", "10.0.1.7", "")
	m := markOf(t, rep)
	// attaches n-office|r1 and n-dmz|r2 plus the r1–r2 link, all bare names
	want := []string{"n-dmz\x00r2", "n-office\x00r1", "r1\x00r2"}
	if got := sortStrings(m.OkE); !slicesEqual(got, want) {
		t.Fatalf("okE: want %v, got %v", want, got)
	}
}

func TestMarkMap_DenySplitsRoute(t *testing.T) {
	// diagRulesDeny: defaultAction allow, block-dmz deny matched on both
	// routers — the first denying router (r1) is the cut point.
	rep := runDiag(t, diagRulesDeny, "10.0.0.5", "10.0.1.7", "")
	m := markOf(t, rep)
	if got := sortStrings(m.Ok); !slicesEqual(got, []string{"n-office"}) {
		t.Fatalf("ok stops before the deny point: got %v", got)
	}
	denyRouter, ok := m.Deny["r1"]
	if !ok {
		t.Fatalf("deny must be attributed to r1, got %v", m.Deny)
	}
	if denyRouter.Rule != "block-dmz" {
		t.Fatalf("deny info must carry the matched rule, got %+v", denyRouter)
	}
	// everything beyond r1 (the r1–r2 edge and the n-dmz attach) is red
	want := []string{"n-dmz\x00r2", "r1\x00r2"}
	if got := sortStrings(m.DenyE); !slicesEqual(got, want) {
		t.Fatalf("denyE: want %v, got %v", want, got)
	}
	if !containsStr(m.Highlight, "n-dmz") {
		t.Fatalf("the full route stays highlighted, got %v", m.Highlight)
	}
}

func TestMarkMap_HalfWhenNoReturnPath(t *testing.T) {
	// diagRulesAllow is one-directional: office→dmz on 443 allowed, no mirror.
	rep := runDiag(t, diagRulesAllow, "10.0.0.5", "10.0.1.7", rules.ProtoTCP, "443")
	m := markOf(t, rep)
	if len(m.Ok) != 0 || len(m.OkE) != 0 {
		t.Fatalf("one-way report leaves ok empty, got ok=%v okE=%v", m.Ok, m.OkE)
	}
	if got := sortStrings(m.Half); !slicesEqual(got, []string{"n-dmz", "n-office", "r1", "r2"}) {
		t.Fatalf("half: want the full route, got %v", got)
	}
	if len(m.HalfE) != 3 {
		t.Fatalf("half edges: want both attaches and the link, got %v", m.HalfE)
	}
}

func TestMarkMap_SameSubnetDegeneratePath(t *testing.T) {
	rep := runDiag(t, diagRulesAllowBothWays, "10.0.0.1", "10.0.0.200", "")
	m := markOf(t, rep)
	if got := sortStrings(m.Ok); !slicesEqual(got, []string{"n-office"}) {
		t.Fatalf("degenerate L2 path lights only the owning network, got %v", got)
	}
	if got := sortStrings(m.Highlight); !slicesEqual(got, []string{"n-office"}) {
		t.Fatalf("degenerate highlight: got %v", got)
	}
}

func TestMarkMap_UnreachableLeavesEmptyMark(t *testing.T) {
	rep := runDiag(t, diagRulesAllowBothWays, "10.0.0.5", "10.0.2.7", "")
	m := markOf(t, rep)
	if len(m.Highlight) != 0 || len(m.Ok) != 0 || len(m.Deny) != 0 || len(m.Half) != 0 {
		t.Fatalf("no paths → empty mark, got %+v", m)
	}
	// empty arrays, not null: the frontend iterates them directly
	b := mustJSON(t, rep)
	if strings.Contains(b, ":null") {
		t.Fatalf("JSON contains null arrays: %s", b)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsStr(list []string, s string) bool {
	return slices.Index(list, s) >= 0
}
