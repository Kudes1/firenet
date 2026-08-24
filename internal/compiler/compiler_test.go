package compiler

import (
	"net/netip"
	"sort"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

func TestIPSetName_IsReadableEntityName(t *testing.T) {
	cases := map[string]string{
		"office-net": "fn_office-net",
		"MAIN":       "fn_MAIN",
		"mr/1":       "fn_mr_1",
		"a b":        "fn_a_b",
	}
	for entity, want := range cases {
		if got := ipsetName(entity); got != want {
			t.Errorf("ipsetName(%q) = %q, want %q", entity, got, want)
		}
	}
}

func TestIPSetName_FitsIpsetNameLimit(t *testing.T) {
	long := strings.Repeat("office", 10)
	got := ipsetName(long)
	if len(got) > 31 {
		t.Fatalf("ipset name %q exceeds 31 chars", got)
	}
	if !strings.HasPrefix(got, "fn_") {
		t.Fatalf("truncated name %q lost the fn_ prefix", got)
	}
	if got != ipsetName(long) {
		t.Fatalf("ipsetName is not deterministic: %q vs %q", got, ipsetName(long))
	}
}

func TestCompile_SanitizationCollisionsGetDistinctNames(t *testing.T) {
	topo := redundantTopology(t)
	topo.Subnets["a/b"] = topology.Subnet{Name: "a/b", CIDR: prefix(t, "10.0.5.0/24")}
	topo.Subnets["a b"] = topology.Subnet{Name: "a b", CIDR: prefix(t, "10.0.6.0/24")}
	topo.Networks["nAB1"] = topology.Network{Name: "nAB1", Subnets: []string{"a/b"}, Attach: []topology.Endpoint{{Device: "r1"}}}
	topo.Networks["nAB2"] = topology.Network{Name: "nAB2", Subnets: []string{"a b"}, Attach: []topology.Endpoint{{Device: "r1"}}}
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "to-a-slash-b", Src: []string{"A"}, Dst: []string{"a/b"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
			{Name: "to-a-space-b", Src: []string{"A"}, Dst: []string{"a b"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	names := make(map[string]string) // ipset name -> display name
	for _, s := range d.IPSets {
		if !strings.HasPrefix(strings.ToLower(s.Name), "fn_a") {
			t.Fatalf("ipset %q must derive from entity name, not a bare hash", s.Name)
		}
		if prev, dup := names[s.Name]; dup {
			t.Fatalf("distinct entities %q and %q share ipset name %q", prev, s.DisplayName, s.Name)
		}
		names[s.Name] = s.DisplayName
	}
	dstSets := map[string]bool{}
	for _, r := range d.Rules {
		if dstSets[r.DstSet] {
			t.Fatalf("two rules reference the same DstSet %q", r.DstSet)
		}
		dstSets[r.DstSet] = true
	}
}

func prefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse prefix %q: %v", s, err)
	}
	return p
}

// redundantTopology has subnets A and B each dual-homed to r1 and r2, plus a
// third, unrelated router r3 that no rule should ever touch.
func redundantTopology(t *testing.T) *topology.Topology {
	t.Helper()
	topo := &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
			"r2": {Name: "r2", Kind: topology.DeviceRouter},
			"r3": {Name: "r3", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"A": {Name: "A", CIDR: prefix(t, "10.0.0.0/24")},
			"B": {Name: "B", CIDR: prefix(t, "10.0.1.0/24")},
			"C": {Name: "C", CIDR: prefix(t, "10.0.2.0/24")},
		},
		Networks: map[string]topology.Network{
			"ab": {Name: "ab", Subnets: []string{"A", "B"}, Attach: []topology.Endpoint{
				{Device: "r1"}, {Device: "r2"},
			}},
			"nC": {Name: "nC", Subnets: []string{"C"}, Attach: []topology.Endpoint{
				{Device: "r3"},
			}},
		},
	}
	if err := topo.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	return topo
}

func deviceOf(t *testing.T, ds []DeviceRuleset, name string) DeviceRuleset {
	t.Helper()
	for _, d := range ds {
		if d.Device == name {
			return d
		}
	}
	t.Fatalf("no ruleset for device %q", name)
	return DeviceRuleset{}
}

func requireNoDevice(t *testing.T, ds []DeviceRuleset, name string) {
	t.Helper()
	for _, d := range ds {
		if d.Device == name {
			t.Fatalf("%s: got a ruleset (%d rules), want none — a router with no rules should be omitted entirely", name, len(d.Rules))
		}
	}
}

func TestCompile_PlacesOnBothRedundantRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "a-to-b-https", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	for _, name := range []string{"r1", "r2"} {
		d := deviceOf(t, out, name)
		if len(d.Rules) != 1 {
			t.Fatalf("%s: got %d rules, want 1", name, len(d.Rules))
		}
		if d.Rules[0].SrcSet == "" || d.Rules[0].DstSet == "" {
			t.Fatalf("%s: expected both src and dst ipset matches, got %+v", name, d.Rules[0])
		}
	}

	// r3 is unrelated to A/B traffic and must not receive a ruleset at all.
	requireNoDevice(t, out, "r3")
}

func TestCompile_NetworkExpandsToMembers(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "c-to-ab", Src: []string{"C"}, Dst: []string{"ab"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	// C has no path to A or B in this fixture (r3 is isolated), so the rule
	// resolves to zero placements and no device gets a ruleset at all.
	if len(out) != 0 {
		t.Fatalf("got %d devices, want 0 (C is unreachable from ab)", len(out))
	}
}

func TestCompile_AnyAnyPlacesOnAllRouters(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "allow-icmp", Src: []string{rules.Any}, Dst: []string{rules.Any}, Proto: rules.ProtoICMP, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for _, name := range []string{"r1", "r2", "r3"} {
		d := deviceOf(t, out, name)
		if len(d.Rules) != 1 {
			t.Fatalf("%s: got %d rules, want 1 (any-any must reach every router)", name, len(d.Rules))
		}
		if d.Rules[0].SrcSet != "" || d.Rules[0].DstSet != "" {
			t.Fatalf("%s: any-any rule must be unconditional, got %+v", name, d.Rules[0])
		}
	}
}

func TestCompile_SetIpsetContainsSubnetsAndAddresses(t *testing.T) {
	topo := redundantTopology(t)
	host, _ := netip.ParseAddr("10.0.0.9")
	topo.Sets = map[string]topology.Set{
		"blocked": {Name: "blocked", Subnets: []string{"B"}, Addresses: []netip.Prefix{netip.PrefixFrom(host, host.BitLen())}},
	}
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "a-to-blocked", Src: []string{"A"}, Dst: []string{"blocked"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	d := deviceOf(t, out, "r1")
	var blocked *IPSet
	for i := range d.IPSets {
		if d.IPSets[i].DisplayName == "blocked" {
			blocked = &d.IPSets[i]
		}
	}
	if blocked == nil {
		t.Fatalf("no ipset for set \"blocked\", got %+v", d.IPSets)
	}
	wantCIDRs := []string{"10.0.0.9/32", "10.0.1.0/24"}
	sort.Strings(blocked.CIDRs)
	if len(blocked.CIDRs) != len(wantCIDRs) || blocked.CIDRs[0] != wantCIDRs[0] || blocked.CIDRs[1] != wantCIDRs[1] {
		t.Fatalf("ipset CIDRs = %v, want %v", blocked.CIDRs, wantCIDRs)
	}
	if d.Rules[0].DstSet != ipsetName("blocked") {
		t.Fatalf("rule must reference the set's ipset, got %+v", d.Rules[0])
	}
}

func TestCompile_DedupIdenticalRules(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "rule-one", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
			{Name: "rule-two", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	if len(d.Rules) != 1 {
		t.Fatalf("got %d rules, want 1 after dedup", len(d.Rules))
	}
}

func TestCompile_CommentPrefersCommentOverName(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "named", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
			{Name: "described", Comment: "доступ к БД", Src: []string{"B"}, Dst: []string{"A"}, Proto: rules.ProtoTCP, DstPorts: []string{"5432"}, Action: rules.ActionDeny},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	var named, described *CompiledRule
	for i := range d.Rules {
		switch d.Rules[i].Comment {
		case "named":
			named = &d.Rules[i]
		case "доступ к БД":
			described = &d.Rules[i]
		}
	}
	if named == nil {
		t.Fatalf("rule without comment must fall back to its name in --comment")
	}
	if described == nil {
		t.Fatalf("rule comment must reach CompiledRule.Comment, got rules: %+v", d.Rules)
	}
}

func TestCompile_LiteralEndpointInsideSubnet(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "host-to-b", Src: []string{"10.0.0.5"}, Dst: []string{"B"}, Proto: rules.ProtoAny, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	for _, name := range []string{"r1", "r2"} {
		d := deviceOf(t, out, name)
		r := d.Rules[0]
		if r.SrcSet != "" || r.SrcAddr != "10.0.0.5/32" {
			t.Fatalf("%s: literal src must match by address without an ipset, got %+v", name, r)
		}
	}
	requireNoDevice(t, out, "r3")

	// No ipset may be created for the literal host: only B's set remains.
	d := deviceOf(t, out, "r1")
	if len(d.IPSets) != 1 || d.IPSets[0].DisplayName != "B" {
		t.Fatalf("literal endpoint must not create an ipset, got %+v", d.IPSets)
	}
}

func TestCompile_LiteralCIDRMatchesByAddress(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "range-to-b", Src: []string{"10.0.0.77/24"}, Dst: []string{"B"}, Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	if len(d.IPSets) != 1 || d.IPSets[0].DisplayName != "B" {
		t.Fatalf("literal CIDR must not create an ipset, got %+v", d.IPSets)
	}
	if d.Rules[0].SrcAddr != "10.0.0.0/24" {
		t.Fatalf("literal CIDR must be masked in SrcAddr, got %+v", d.Rules[0])
	}
}

func TestCompile_LiteralEndpointOutsideSubnetsPlacesEverywhere(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "wan-host-to-a", Src: []string{"192.168.9.9"}, Dst: []string{"A"}, Proto: rules.ProtoTCP, DstPorts: []string{"22"}, Action: rules.ActionAllow},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	// The address belongs to no declared subnet, so pathfinding cannot tell
	// where it enters the network — place conservatively on every router.
	for _, name := range []string{"r1", "r2", "r3"} {
		deviceOf(t, out, name)
	}
}

func TestCompileMultiChainPlacementAndTargetGuarantee(t *testing.T) {
	topo := redundantTopology(t)
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	pol := &rules.Policy{Chains: []rules.Chain{
		{
			Name: "FIRENET-FWD", DefaultAction: rules.ActionDeny, ChainPosition: rules.ChainTop,
			Rules: []rules.Rule{{
				Name: "restrict", Src: []string{"A"}, Dst: []string{"B"},
				Action: rules.ActionJump, JumpTo: "FIRENET-RESTRICTED",
			}},
		},
		{Name: "FIRENET-RESTRICTED", DefaultAction: rules.ActionDeny,
			Rules: []rules.Rule{{
				Name: "restricted-dns", Src: []string{"A"}, Dst: []string{"B"},
				Proto: rules.ProtoUDP, DstPorts: []string{"53"}, Action: rules.ActionAllow,
			}},
		},
	}}
	devices, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range devices {
		for _, r := range d.Rules {
			if r.JumpTo == "FIRENET-RESTRICTED" {
				found = true
				ok := false
				for _, ch := range d.Chains {
					if ch.Name == "FIRENET-RESTRICTED" {
						ok = true
					}
				}
				if !ok {
					t.Fatalf("device %s jumps to missing chain", d.Device)
				}
				if r.Chain != "FIRENET-FWD" {
					t.Fatalf("jump rule owner = %q", r.Chain)
				}
			}
		}
	}
	if !found {
		t.Fatal("no compiled jump rule")
	}
}

func TestCompileDedupKeepsDifferentChains(t *testing.T) {
	topo := redundantTopology(t)
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	same := rules.Rule{Name: "r", Src: []string{"A"}, Dst: []string{"B"}, Action: rules.ActionAllow}
	pol := &rules.Policy{Chains: []rules.Chain{
		{Name: "A", DefaultAction: rules.ActionDeny, Rules: []rules.Rule{same}},
		{Name: "B", DefaultAction: rules.ActionReturn, Rules: []rules.Rule{same}},
	}}
	devices, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range devices {
		aCount, bCount := 0, 0
		for _, r := range d.Rules {
			switch r.Chain {
			case "A":
				aCount++
			case "B":
				bCount++
			}
		}
		if aCount != 1 || bCount != 1 {
			t.Fatalf("device %s: A=%d B=%d, want 1/1", d.Device, aCount, bCount)
		}
	}
}

func TestCompile_MirrorExpandsReverseDirection(t *testing.T) {
	topo := redundantTopology(t)
	pol := &rules.Policy{Chains: []rules.Chain{{
		Name:          "FIRENET-FWD",
		DefaultAction: rules.ActionDeny,
		ChainPosition: rules.ChainTop,
		Rules: []rules.Rule{
			{Name: "ab-tcp", Src: []string{"A"}, Dst: []string{"B"}, Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow, Mirror: true},
		},
	}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("invalid rules: %v", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		t.Fatalf("build graph: %v", err)
	}
	out, err := Compile(topo, pol, g, graph.DefaultLimits())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	d := deviceOf(t, out, "r1")
	if len(d.Rules) != 2 {
		t.Fatalf("got %d rules, want 2 (original + mirrored)", len(d.Rules))
	}
	forward, reverse := d.Rules[0], d.Rules[1]
	if forward.SrcSet != ipsetName("A") || forward.DstSet != ipsetName("B") {
		t.Fatalf("unexpected forward rule: %+v", forward)
	}
	if reverse.SrcSet != ipsetName("B") || reverse.DstSet != ipsetName("A") {
		t.Fatalf("unexpected reverse rule: %+v", reverse)
	}
	if len(forward.SrcPorts) != 0 || len(forward.DstPorts) != 1 || forward.DstPorts[0] != "443" {
		t.Fatalf("unexpected forward ports: %+v", forward)
	}
	if len(reverse.DstPorts) != 0 || len(reverse.SrcPorts) != 1 || reverse.SrcPorts[0] != "443" {
		t.Fatalf("mirrored rule must swap ports (dst port becomes src port on reverse), got: %+v", reverse)
	}
	if len(pol.Primary().Rules) != 1 {
		t.Fatalf("mirroring must not mutate the source policy, got %d rules", len(pol.Primary().Rules))
	}
}
