package rules

import (
	"testing"
)

func TestFilterRules_EmptyReturnsAll(t *testing.T) {
	rules := []Rule{baseRule(), {Name: "second", Src: []string{Any}, Dst: []string{Any}, Action: ActionDeny}}
	got := FilterRules(rules, Filters{}, testTopology(t))
	if len(got) != 2 {
		t.Fatalf("empty filters must keep all rules, got %d", len(got))
	}
}

func TestFilterRules_NameSubstring(t *testing.T) {
	a, b := baseRule(), baseRule()
	a.Name, b.Name = "office-to-dmz", "guest-isolation"
	got := FilterRules([]Rule{a, b}, Filters{Name: "DMZ"}, testTopology(t))
	if len(got) != 1 || got[0].Name != "office-to-dmz" {
		t.Fatalf("expected only office-to-dmz (case-insensitive), got %+v", got)
	}
}

func TestFilterRules_CombinesFieldsWithAND(t *testing.T) {
	a := baseRule()
	a.Name, a.Src = "office-to-dmz", []string{"office"}
	b := baseRule()
	b.Name = "other-name"
	got := FilterRules([]Rule{a, b}, Filters{Name: "office", Src: "dmz"}, testTopology(t))
	if len(got) != 0 {
		t.Fatalf("name matches a but src does not: expected no rules, got %+v", got)
	}
	got = FilterRules([]Rule{a, b}, Filters{Name: "office", Src: "office"}, testTopology(t))
	if len(got) != 1 || got[0].Name != "office-to-dmz" {
		t.Fatalf("both fields match rule a, got %+v", got)
	}
}

func TestFilterRules_ProtoAndActionAndPorts(t *testing.T) {
	tcp443 := baseRule()
	tcp443.Proto, tcp443.DstPorts = ProtoTCP, []string{"443"}
	udpAny := baseRule()
	udpAny.Name, udpAny.Proto, udpAny.Action = "udp-any", ProtoUDP, ActionDeny

	cases := []struct {
		f       Filters
		wantLen int
	}{
		{Filters{Proto: "tcp"}, 1},
		{Filters{Action: "deny"}, 1},
		{Filters{DstPorts: "443"}, 1},
		{Filters{SrcPorts: "80"}, 0},
		{Filters{Proto: "TCP"}, 1}, // case-insensitive
	}
	for _, tc := range cases {
		got := FilterRules([]Rule{tcp443, udpAny}, tc.f, testTopology(t))
		if len(got) != tc.wantLen {
			t.Errorf("filters %+v: got %d rules, want %d", tc.f, len(got), tc.wantLen)
		}
	}
}

func TestFilterRules_EndpointNameSubstring(t *testing.T) {
	a := baseRule() // src=office
	b := baseRule()
	b.Src = []string{Any}
	got := FilterRules([]Rule{a, b}, Filters{Src: "ffic"}, testTopology(t))
	if len(got) != 1 || got[0].Name != "r" {
		t.Fatalf("substring over endpoint names should match office, got %+v", got)
	}
}

func TestFilterRules_IPMatchesSubnet(t *testing.T) {
	inOffice := baseRule() // src=office 10.0.0.0/24
	other := baseRule()
	other.Name, other.Src = "any-src", []string{Any}

	got := FilterRules([]Rule{inOffice, other}, Filters{Src: "10.0.0.55"}, testTopology(t))
	if len(got) != 2 {
		t.Fatalf("IP inside office subnet matches office rule and 'any' rule, got %+v", got)
	}

	got = FilterRules([]Rule{inOffice, other}, Filters{Src: "192.168.1.1"}, testTopology(t))
	if len(got) != 1 || got[0].Name != "any-src" {
		t.Fatalf("only 'any' should match foreign IP, got %+v", got)
	}

	got = FilterRules([]Rule{inOffice, other}, Filters{Dst: "10.0.0.55"}, testTopology(t))
	if len(got) != 2 {
		t.Fatalf("'any' dst should match any IP for both rules, got %d", len(got))
	}
}

func TestFilterRules_CIDROverlap(t *testing.T) {
	a := baseRule() // src=office /24
	got := FilterRules([]Rule{a}, Filters{Src: "10.0.0.128/25"}, testTopology(t))
	if len(got) != 1 {
		t.Fatal("overlapping query CIDR should match subnet")
	}
	got = FilterRules([]Rule{a}, Filters{Src: "10.0.1.0/24"}, testTopology(t))
	if len(got) != 0 {
		t.Fatal("non-overlapping CIDR must not match")
	}
}

func TestFilterRules_ZoneExpandsToSubnetsForIP(t *testing.T) {
	ruleViaZone := baseRule()
	ruleViaZone.Src = []string{"internal"} // zone containing office

	got := FilterRules([]Rule{ruleViaZone}, Filters{Src: "10.0.0.9"}, testTopology(t))
	if len(got) != 1 {
		t.Fatal("IP in zone member subnet should match zone endpoint")
	}
	got = FilterRules([]Rule{ruleViaZone}, Filters{Src: "10.9.0.1"}, testTopology(t))
	if len(got) != 0 {
		t.Fatal("IP outside zone must not match")
	}
}

func TestFilterRules_PartialIPMatches(t *testing.T) {
	a := baseRule() // src=office 10.0.0.0/24
	cases := []struct {
		q    string
		want int
	}{
		{"10.", 1},
		{"10.0", 1},
		{"10.0.0", 1},
		{"10.0.0.", 1},
		{"11.", 0},
		{"10.1", 0},
	}
	for _, tc := range cases {
		got := FilterRules([]Rule{a}, Filters{Src: tc.q}, testTopology(t))
		if len(got) != tc.want {
			t.Errorf("partial IP %q: got %d rules, want %d", tc.q, len(got), tc.want)
		}
	}
}

func TestFilterRules_NonNumericStillNameSubstring(t *testing.T) {
	rule := baseRule() // src=office
	got := FilterRules([]Rule{rule}, Filters{Src: "off"}, testTopology(t))
	if len(got) != 1 {
		t.Fatal("non-numeric input must fall back to endpoint name substring")
	}
}

func TestFilterRules_AnyEndpointMatchesAnyIP(t *testing.T) {
	rule := baseRule()
	rule.Dst = []string{Any}
	got := FilterRules([]Rule{rule}, Filters{Dst: "8.8.8.8"}, testTopology(t))
	if len(got) != 1 {
		t.Fatal("'any' endpoint should match any IP")
	}
}
