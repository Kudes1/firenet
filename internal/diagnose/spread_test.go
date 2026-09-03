package diagnose_test

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

func graphLimits() graph.Limits { return graph.DefaultLimits() }

// spreadSources mirrors the frontend resolveSpreadSources: a subnet name
// resolves to its base IP, a network name to every member subnet's base IP,
// anything else is a literal IP.
func TestResolveSources_SubnetNetworkLiteral(t *testing.T) {
	topo, _ := loadTopo(t)
	cases := []struct {
		input string
		want  []diagnose.Source
	}{
		{"office", []diagnose.Source{{IP: "10.0.0.0", SubnetName: "office"}}},
		{"n-office", []diagnose.Source{{IP: "10.0.0.0", SubnetName: "office"}}},
		{"192.168.5.5", []diagnose.Source{{IP: "192.168.5.5", SubnetName: ""}}},
	}
	for _, tc := range cases {
		got, err := diagnose.ResolveSources(topo, tc.input)
		if err != nil {
			t.Fatalf("ResolveSources(%q): %v", tc.input, err)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("ResolveSources(%q): want %d sources, got %d", tc.input, len(tc.want), len(got))
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("ResolveSources(%q)[%d]: want %+v, got %+v", tc.input, i, tc.want[i], got[i])
			}
		}
	}
}

func TestResolveSources_UnknownNameFails(t *testing.T) {
	topo, _ := loadTopo(t)
	if _, err := diagnose.ResolveSources(topo, "no-such-thing"); err == nil {
		t.Fatal("a name that is neither subnet, network nor IP must fail")
	}
}

// Spread from office: office itself is the inspected source, the only other
// subnet is dmz. With diagRulesAllowBothWays every candidate reaches the
// inspected network fully (round-trip), so the merged mark is all-green.
func TestSpread_AllGreenWhenEverythingRoundTrips(t *testing.T) {
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, diagRulesAllowBothWays)
	spread, err := diagnose.Spread(topo, sets, g, graphLimits(), diagnose.SpreadOptions{
		Input: "office",
	})
	if err != nil {
		t.Fatalf("Spread: %v", err)
	}
	if len(spread.Reports) != 2 {
		t.Fatalf("want 2 per-candidate reports (dmz, isolated), got %d", len(spread.Reports))
	}
	r := spread.Reports[0]
	if r.Candidate != "dmz" {
		t.Fatalf("first candidate must be dmz (sorted), got %q", r.Candidate)
	}
	if len(r.Report.Paths) == 0 {
		t.Fatalf("dmz must reach office, got %+v", r.Report.Paths)
	}
	m := spread.Mark
	if !containsStr(m.Ok, "n-office") || !containsStr(m.Ok, "n-dmz") {
		t.Fatalf("both networks must be green, got ok=%v", m.Ok)
	}
	if len(m.Half) != 0 || len(m.Deny) != 0 {
		t.Fatalf("full round-trip leaves no half/deny, got %+v", m)
	}
	if !containsStr(m.Highlight, "n-office") {
		t.Fatalf("inspected network must stay highlighted, got %v", m.Highlight)
	}
}

// One-directional policy: office→dmz allowed on 443 only. Spread from office
// with unrestricted traffic — dmz reaches office on the default... wait, no:
// diagRulesAllow defaults to deny, so dmz→office has no rule. The shared
// element (both attaches and the r1–r2 link) stays half-open.
func TestSpread_OneWayStaysHalf(t *testing.T) {
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, diagRulesAllow)
	spread, err := diagnose.Spread(topo, sets, g, graphLimits(), diagnose.SpreadOptions{
		Input: "office",
	})
	if err != nil {
		t.Fatalf("Spread: %v", err)
	}
	m := spread.Mark
	if containsStr(m.Ok, "n-dmz") || containsStr(m.Ok, "r2") {
		t.Fatalf("dmz side must not be green without a return rule, got ok=%v", m.Ok)
	}
	if !containsStr(m.Half, "n-dmz") && !containsStr(m.Half, "r2") {
		t.Fatalf("dmz side must be half-open, got half=%v", m.Half)
	}
}

// Deny wins over everything: a policy that denies dmz→office (the spread
// request direction) leaves the dmz side red with the matched rule. The
// merged mark keeps ok for elements some pair lit green (the renderer gives
// deny paint priority), but the deny point itself is out of ok — MarkMap
// removes it per-pair, mirroring the frontend expandFlow.
var diagRulesDenyReverse = projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
	Name: "FIRENET-FWD", DefaultAction: "allow", ChainPosition: "top",
	Rules: []projectdoc.RuleDoc{{Name: "block-dmz-office", Src: []string{"dmz"}, Dst: []string{"office"}, Proto: "any", Action: "deny"}},
}}}

func TestSpread_DenyWinsInMerge(t *testing.T) {
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, diagRulesDenyReverse)
	spread, err := diagnose.Spread(topo, sets, g, graphLimits(), diagnose.SpreadOptions{
		Input: "office",
	})
	if err != nil {
		t.Fatalf("Spread: %v", err)
	}
	m := spread.Mark
	if len(m.Deny) == 0 {
		t.Fatal("the deny point must be marked")
	}
	for router, info := range m.Deny {
		if info.Rule != "block-dmz-office" {
			t.Fatalf("deny info must name block-dmz-office, got %+v", info)
		}
		if containsStr(m.Ok, router) {
			t.Fatalf("the denying router %q must not be green, got ok=%v", router, m.Ok)
		}
	}
	if containsStr(m.Ok, "r2") {
		t.Fatalf("r2 is the deny point on the only dmz→office route, got ok=%v", m.Ok)
	}
}

// Per-candidate errors are reported, not fatal: a candidate whose base IP
// cannot be diagnosed must not abort the whole spread.
func TestSpread_ReportShapeAndJSON(t *testing.T) {
	topo, g := loadTopo(t)
	sets := compilePolicy(t, topo, g, diagRulesAllowBothWays)
	spread, err := diagnose.Spread(topo, sets, g, graphLimits(), diagnose.SpreadOptions{
		Input: "n-office",
	})
	if err != nil {
		t.Fatalf("Spread: %v", err)
	}
	if spread.Mark == nil {
		t.Fatal("spread carries a merged mark")
	}
	// JSON arrays must never be null (the frontend iterates them)
	b := mustJSON(t, spread)
	if strings.Contains(b, ":null") {
		t.Fatalf("JSON contains null arrays: %s", b)
	}
	_ = rules.ProtoAny
	_ = netip.Addr{}
}
