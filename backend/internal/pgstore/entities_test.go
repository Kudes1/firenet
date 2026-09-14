package pgstore

import (
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

func sampleDoc() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices:  []projectdoc.DeviceDoc{{Name: "r1", Kind: "router"}, {Name: "r2", Kind: "router"}},
			Links:    []projectdoc.LinkDoc{{A: projectdoc.EndpointDoc{Device: "r2"}, B: projectdoc.EndpointDoc{Device: "r1"}}},
			Networks: []projectdoc.NetworkDoc{{Name: "n1", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}}},
			Sets:     []projectdoc.SetDoc{{Name: "s1", Subnets: []string{"office"}}},
			Unions:   []projectdoc.UnionDoc{{Name: "u1", Devices: []string{"r1"}}},
		},
		Subnets: projectdoc.SubnetsDoc{Subnets: []projectdoc.SubnetDoc{{Name: "office", CIDR: "10.0.0.0/24"}}},
		Rules: projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{
			{Name: "FIRENET-FWD", DefaultAction: "deny", Rules: []projectdoc.RuleDoc{
				{Name: "r-a", Src: []string{"any"}, Dst: []string{"any"}, Action: "allow"},
				{Name: "r-b", Src: []string{"any"}, Dst: []string{"any"}, Action: "deny"},
			}},
		}},
		Layout: projectdoc.LayoutDoc{
			Devices: map[string]projectdoc.LayoutPoint{"r1": {X: 1, Y: 2}},
			Links:   map[string][][]projectdoc.LayoutPoint{"r1|r2": {{{X: 0, Y: 0}}}},
			Camera:  &projectdoc.LayoutCamera{X: 1, Y: 2, Z: 1},
		},
	}
}

func TestToEntitiesCoversEveryKind(t *testing.T) {
	entities, err := toEntities(sampleDoc())
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}

	wantKinds := map[string]bool{
		kindDevice: false, kindLink: false, kindNetwork: false, kindSet: false, kindUnion: false,
		kindSubnet: false, kindChain: false, kindRule: false,
		kindLayoutDevice: false, kindLayoutLink: false, kindLayoutCamera: false,
	}
	for ref := range entities {
		if _, ok := wantKinds[ref.Kind]; ok {
			wantKinds[ref.Kind] = true
		}
	}
	for kind, seen := range wantKinds {
		if !seen {
			t.Errorf("no entity of kind %q produced", kind)
		}
	}
}

func TestLinkKeyIsOrderNormalized(t *testing.T) {
	if linkKey("r2", "r1") != linkKey("r1", "r2") {
		t.Fatalf("linkKey should ignore endpoint order")
	}
	if got, want := linkKey("r2", "r1"), "r1|r2"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestToEntitiesThenFromEntitiesRoundTrips(t *testing.T) {
	doc := sampleDoc()
	entities, err := toEntities(doc)
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}

	snapshot := make(map[entityRef]entityRow, len(entities))
	for ref, data := range entities {
		snapshot[ref] = entityRow{Change: "added", Data: data}
	}

	got, err := fromEntities(snapshot)
	if err != nil {
		t.Fatalf("fromEntities: %v", err)
	}

	if len(got.Topology.Devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(got.Topology.Devices))
	}
	if len(got.Topology.Links) != 1 || got.Topology.Links[0].A.Device != "r2" || got.Topology.Links[0].B.Device != "r1" {
		t.Fatalf("got links %+v, want the original r2->r1 link preserved", got.Topology.Links)
	}
	if len(got.Rules.Chains) != 1 || len(got.Rules.Chains[0].Rules) != 2 {
		t.Fatalf("got chains %+v", got.Rules.Chains)
	}
	if got.Rules.Chains[0].Rules[0].Name != "r-a" || got.Rules.Chains[0].Rules[1].Name != "r-b" {
		t.Fatalf("rule order not preserved: %+v", got.Rules.Chains[0].Rules)
	}
	if got.Layout.Devices["r1"] != (projectdoc.LayoutPoint{X: 1, Y: 2}) {
		t.Fatalf("got layout device %+v", got.Layout.Devices["r1"])
	}
	if got.Layout.Camera == nil || *got.Layout.Camera != (projectdoc.LayoutCamera{X: 1, Y: 2, Z: 1}) {
		t.Fatalf("got layout camera %+v", got.Layout.Camera)
	}
}

func TestFromEntitiesSkipsRemoved(t *testing.T) {
	doc := sampleDoc()
	entities, err := toEntities(doc)
	if err != nil {
		t.Fatalf("toEntities: %v", err)
	}
	snapshot := make(map[entityRef]entityRow, len(entities))
	for ref, data := range entities {
		snapshot[ref] = entityRow{Change: "added", Data: data}
	}
	snapshot[entityRef{Kind: kindDevice, Key: "r2"}] = entityRow{Change: "removed"}

	got, err := fromEntities(snapshot)
	if err != nil {
		t.Fatalf("fromEntities: %v", err)
	}
	for _, d := range got.Topology.Devices {
		if d.Name == "r2" {
			t.Fatalf("removed device r2 still present: %+v", got.Topology.Devices)
		}
	}
}
