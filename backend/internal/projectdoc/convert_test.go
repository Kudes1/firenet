package projectdoc

import (
	"slices"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

func sampleDoc() ProjectDoc {
	return ProjectDoc{
		Topology: TopologyDoc{
			Devices: []DeviceDoc{
				{Name: "r1", Kind: "router", Description: "edge"},
				{Name: "s1", Kind: "switch"},
			},
			Links: []LinkDoc{
				{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "s1"}},
				{
					A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "s1"},
					Filter: &LinkFilterDoc{AExports: []string{"MARKET"}, BExports: []string{"MAIN"}},
				},
			},
			Networks: []NetworkDoc{
				{Name: "office", Subnets: []string{"lan"}, Attach: []EndpointDoc{{Device: "s1"}}, Description: "lan"},
			},
			Sets: []SetDoc{
				{Name: "hosts", Subnets: []string{"lan"}, Addresses: []string{"10.0.0.5", "10.0.0.6/32"}, Description: "grp"},
			},
			Unions: []UnionDoc{
				{Name: "hq", Devices: []string{"r1"}, Networks: []string{"office"}},
			},
		},
		Subnets: SubnetsDoc{
			Subnets: []SubnetDoc{{Name: "lan", CIDR: "10.0.0.0/24", Description: "main"}},
		},
	}
}

func TestToTopology_ConvertsAllEntities(t *testing.T) {
	topo, err := sampleDoc().Topology.ToTopology()
	if err != nil {
		t.Fatalf("ToTopology: %v", err)
	}
	if len(topo.Devices) != 2 || topo.Devices["r1"] != (topology.Device{Name: "r1", Kind: topology.DeviceRouter, Description: "edge"}) {
		t.Fatalf("devices: %+v", topo.Devices)
	}
	if topo.Devices["s1"].Kind != topology.DeviceSwitch {
		t.Fatalf("switch kind: %+v", topo.Devices["s1"])
	}
	if len(topo.Links) != 2 {
		t.Fatalf("links: %+v", topo.Links)
	}
	if topo.Links[0].Filter != nil {
		t.Fatalf("plain link must have nil filter: %+v", topo.Links[0])
	}
	if topo.Links[1].Filter == nil ||
		!slices.Equal(topo.Links[1].Filter.AExports, []string{"MARKET"}) ||
		!slices.Equal(topo.Links[1].Filter.BExports, []string{"MAIN"}) {
		t.Fatalf("filtered link: %+v", topo.Links[1])
	}
	if n := topo.Networks["office"]; n.Subnets[0] != "lan" || n.Attach[0].Device != "s1" || n.Description != "lan" {
		t.Fatalf("network: %+v", n)
	}
	if s := topo.Sets["hosts"]; len(s.Addresses) != 2 || s.Addresses[0].Bits() != 32 {
		t.Fatalf("set: %+v", s)
	}
	if u := topo.Unions["hq"]; !slices.Equal(u.Devices, []string{"r1"}) || !slices.Equal(u.Networks, []string{"office"}) {
		t.Fatalf("union: %+v", u)
	}
}

func TestToTopology_Errors(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*TopologyDoc)
		want string
	}{
		{"bad kind", func(d *TopologyDoc) { d.Devices[0].Kind = "hub" }, `device "r1": invalid kind "hub"`},
		{"dup device", func(d *TopologyDoc) { d.Devices[1].Name = "r1" }, `duplicate device name "r1"`},
		{"dup network", func(d *TopologyDoc) { d.Networks = append(d.Networks, d.Networks[0]) }, `duplicate network name "office"`},
		{"bad address", func(d *TopologyDoc) { d.Sets[0].Addresses = []string{"10.0.0.5/24"} }, `must be a single host`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := sampleDoc()
			tc.mut(&doc.Topology)
			_, err := doc.Topology.ToTopology()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestToSubnets(t *testing.T) {
	sub, err := sampleDoc().Subnets.ToSubnets()
	if err != nil {
		t.Fatalf("ToSubnets: %v", err)
	}
	got := sub["lan"]
	if got.CIDR.String() != "10.0.0.0/24" || got.Description != "main" {
		t.Fatalf("subnet: %+v", got)
	}
}

func TestToSubnets_Errors(t *testing.T) {
	bad := SubnetsDoc{Subnets: []SubnetDoc{{Name: "a", CIDR: "nope"}}}
	if _, err := bad.ToSubnets(); err == nil || !strings.Contains(err.Error(), `invalid cidr "nope"`) {
		t.Fatalf("err = %v", err)
	}
	doc := SubnetsDoc{Subnets: []SubnetDoc{{Name: "lan", CIDR: "10.0.0.0/24"}, {Name: "lan2", CIDR: "10.1.0.0/24"}}}
	// ToSubnets keys by name; duplicate CIDRs are topology.Validate's job.
	_, err := doc.ToSubnets()
	if err != nil {
		t.Fatalf("distinct names, same CIDR: unexpected err %v", err)
	}
	dup := SubnetsDoc{Subnets: []SubnetDoc{{Name: "a", CIDR: "10.0.0.0/24"}, {Name: "a", CIDR: "10.1.0.0/24"}}}
	if _, err := dup.ToSubnets(); err == nil || !strings.Contains(err.Error(), `duplicate subnet name "a"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestToRules(t *testing.T) {
	doc := ProjectDoc{Rules: PolicyDoc{Chains: []ChainDoc{{
		Name: "fwd", DefaultAction: "deny",
		Rules: []RuleDoc{{Name: "allow-lan", Src: []string{"lan"}, Dst: []string{"lan"}, Action: "allow"}},
	}}}}
	pol := doc.ToRules()
	if len(pol.Chains) != 1 || pol.Chains[0].Name != "fwd" {
		t.Fatalf("chains: %+v", pol.Chains)
	}
	if pol.Chains[0].Rules[0].Action != rules.ActionAllow {
		t.Fatalf("rule action: %+v", pol.Chains[0].Rules[0])
	}
}

func TestToRules_Defaults(t *testing.T) {
	doc := ProjectDoc{Rules: PolicyDoc{Chains: []ChainDoc{
		{Rules: []RuleDoc{{Name: "r1", Src: []string{"a"}, Dst: []string{"b"}, Action: "allow"}}},
		{Name: "EXTRA", DefaultAction: "allow", Rules: []RuleDoc{}},
	}}}
	pol := doc.ToRules()
	first := pol.Chains[0]
	if first.Name != "FIRENET-FWD" || first.DefaultAction != rules.ActionDeny || first.ChainPosition != rules.ChainTop {
		t.Fatalf("first chain defaults: %+v", first)
	}
	if first.Rules[0].Proto != rules.ProtoAny {
		t.Fatalf("rule proto default: %+v", first.Rules[0])
	}
	second := pol.Chains[1]
	if second.ChainPosition != "" {
		t.Fatalf("chainPosition must default only on the first chain: %+v", second)
	}
	// round-trip: doc -> policy -> doc keeps the resolved defaults
	back := NewPolicyDoc(pol)
	if back.Chains[0].Name != "FIRENET-FWD" || back.Chains[0].DefaultAction != "deny" {
		t.Fatalf("round-trip lost defaults: %+v", back.Chains[0])
	}
}

func TestConverters_ExpectedTopology(t *testing.T) {
	tdoc := TopologyDoc{
		Devices: []DeviceDoc{
			{Name: "r1", Kind: "router"},
			{Name: "s1", Kind: "switch"},
		},
		Links: []LinkDoc{
			{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "s1"}},
		},
		Networks: []NetworkDoc{
			{Name: "office", Subnets: []string{"lan"}, Attach: []EndpointDoc{{Device: "s1"}}},
		},
		Sets: []SetDoc{
			{Name: "hosts", Subnets: []string{"lan"}, Addresses: []string{"10.0.0.5"}},
		},
		Unions: []UnionDoc{
			{Name: "hq", Devices: []string{"r1"}},
		},
	}
	sdoc := SubnetsDoc{
		Subnets: []SubnetDoc{
			{Name: "lan", CIDR: "10.0.0.0/24"},
		},
	}

	topo, err := tdoc.ToTopology()
	if err != nil {
		t.Fatal(err)
	}
	subnets, err := sdoc.ToSubnets()
	if err != nil {
		t.Fatal(err)
	}
	topo.Subnets = subnets

	if len(topo.Devices) != 2 || len(topo.Links) != 1 || len(topo.Networks) != 1 || len(topo.Sets) != 1 || len(topo.Unions) != 1 || len(topo.Subnets) != 1 {
		t.Fatalf("unexpected topology result: %+v", topo)
	}
}
