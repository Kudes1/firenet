package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/kudes1/firenet/internal/projectdoc"
)

// fixtureProjectDoc is a small, self-contained ProjectDoc for exercising
// applyTopologyOperation without a database: two devices, two networks
// each attached to one device, one union grouping r1 and n-office, and a
// layout position for every device/network. No links — tests that need
// one create it via a "create-link" operation, matching how the editor
// itself would.
func fixtureProjectDoc() projectdoc.ProjectDoc {
	return projectdoc.ProjectDoc{
		Topology: projectdoc.TopologyDoc{
			Devices: []projectdoc.DeviceDoc{
				{Name: "r1", Kind: "router"},
				{Name: "r2", Kind: "router"},
			},
			Networks: []projectdoc.NetworkDoc{
				{Name: "n-office", Subnets: []string{"office"}, Attach: []projectdoc.EndpointDoc{{Device: "r1"}}},
				{Name: "n-dmz", Subnets: []string{"dmz"}, Attach: []projectdoc.EndpointDoc{{Device: "r2"}}},
			},
			Unions: []projectdoc.UnionDoc{
				{Name: "site-a", Devices: []string{"r1"}, Networks: []string{"n-office"}},
			},
		},
		Layout: projectdoc.LayoutDoc{
			Devices:  map[string]projectdoc.LayoutPoint{"r1": {X: 1, Y: 1}, "r2": {X: 2, Y: 2}},
			Networks: map[string]projectdoc.LayoutPoint{"n-office": {X: 3, Y: 3}, "n-dmz": {X: 4, Y: 4}},
		},
	}
}

func TestApplyTopologyOperation_CreateLinkAndSetFilter(t *testing.T) {
	doc := fixtureProjectDoc()
	next, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "create-link", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}},
	})
	if err != nil || len(next.Topology.Links) != 1 {
		t.Fatalf("next=%+v err=%v", next, err)
	}
	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "set-link-filter", Link: &LinkDoc{A: EndpointDoc{Device: "r2"}, B: EndpointDoc{Device: "r1"}},
		Filter: &LinkFilterDoc{AExports: []string{"office"}, BExports: []string{}},
	})
	if err != nil || next.Topology.Links[0].Filter == nil {
		t.Fatal("filter was not set")
	}
}

func TestApplyTopologyOperation_ClearLinkFilter(t *testing.T) {
	doc := fixtureProjectDoc()
	doc.Topology.Links = []LinkDoc{{
		A:      EndpointDoc{Device: "r1"},
		B:      EndpointDoc{Device: "r2"},
		Filter: &LinkFilterDoc{AExports: []string{"office"}, BExports: []string{}},
	}}

	next, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "clear-link-filter", Link: &LinkDoc{A: EndpointDoc{Device: "r2"}, B: EndpointDoc{Device: "r1"}},
	})
	if err != nil {
		t.Fatalf("clear-link-filter: %v", err)
	}
	if next.Topology.Links[0].Filter != nil {
		t.Fatalf("filter still set: %+v", next.Topology.Links[0].Filter)
	}
	// The original link is untouched: applyTopologyOperation never mutates
	// its input.
	if doc.Topology.Links[0].Filter == nil {
		t.Fatal("input doc was mutated")
	}
}

// TestApplyTopologyOperation_DeleteDeviceCascades checks that deleting a
// device also drops everything in the document that named it: its links
// (and their layout waypoints), its network attachments, and its union
// membership — leaving no dangling reference behind for the handler's
// later cross-document validation to trip over.
func TestApplyTopologyOperation_DeleteDeviceCascades(t *testing.T) {
	doc := fixtureProjectDoc()
	doc.Topology.Links = []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}}
	doc.Layout.Links = map[string][][]LayoutPoint{
		layoutLinkKey("r1", "r2"): {{{X: 5, Y: 5}}},
	}

	next, err := applyTopologyOperation(doc, topologyOperation{Kind: "delete-device", DeviceName: "r1"})
	if err != nil {
		t.Fatalf("delete-device: %v", err)
	}
	if got := deviceIndex(next.Topology.Devices, "r1"); got != -1 {
		t.Fatalf("device r1 still present at index %d", got)
	}
	if len(next.Topology.Devices) != 1 || next.Topology.Devices[0].Name != "r2" {
		t.Fatalf("unexpected devices: %+v", next.Topology.Devices)
	}
	if len(next.Topology.Links) != 0 {
		t.Fatalf("link to deleted device survived: %+v", next.Topology.Links)
	}
	if _, ok := next.Layout.Links[layoutLinkKey("r1", "r2")]; ok {
		t.Fatal("layout waypoints for the deleted link survived")
	}
	if n := next.Topology.Networks[networkIndex(next.Topology.Networks, "n-office")]; len(n.Attach) != 0 {
		t.Fatalf("n-office still attached to deleted device: %+v", n.Attach)
	}
	if u := next.Topology.Unions[unionIndex(next.Topology.Unions, "site-a")]; len(u.Devices) != 0 {
		t.Fatalf("union still lists deleted device: %+v", u.Devices)
	}
	if _, ok := next.Layout.Devices["r1"]; ok {
		t.Fatal("layout position for the deleted device survived")
	}

	// The original doc is untouched.
	if len(doc.Topology.Devices) != 2 || len(doc.Topology.Links) != 1 {
		t.Fatal("input doc was mutated")
	}
}

// TestApplyTopologyOperation_DeleteNetworkRemovesFilteredExports protects
// network deletion from leaving filtered links with references to an export
// entity that no longer exists.
func TestApplyTopologyOperation_DeleteNetworkRemovesFilteredExports(t *testing.T) {
	doc := fixtureProjectDoc()
	doc.Topology.Links = []LinkDoc{
		{
			A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"},
			Filter: &LinkFilterDoc{AExports: []string{"n-office"}, BExports: []string{"n-dmz"}},
		},
		{
			A: EndpointDoc{Device: "r2"}, B: EndpointDoc{Device: "r1"},
			Filter: &LinkFilterDoc{AExports: []string{"n-dmz"}, BExports: []string{"n-office"}},
		},
	}

	next, err := applyTopologyOperation(doc, topologyOperation{Kind: "delete-network", NetworkName: "n-office"})
	if err != nil {
		t.Fatalf("delete-network: %v", err)
	}
	if got := networkIndex(next.Topology.Networks, "n-office"); got != -1 {
		t.Fatalf("n-office still present at index %d", got)
	}
	if got := next.Topology.Links[0].Filter; got == nil || len(got.AExports) != 0 || len(got.BExports) != 1 || got.BExports[0] != "n-dmz" {
		t.Fatalf("first link filter = %+v, want only n-dmz on B", got)
	}
	if got := next.Topology.Links[1].Filter; got == nil || len(got.AExports) != 1 || got.AExports[0] != "n-dmz" || len(got.BExports) != 0 {
		t.Fatalf("second link filter = %+v, want only n-dmz on A", got)
	}
	if got := doc.Topology.Links[0].Filter.AExports; len(got) != 1 || got[0] != "n-office" {
		t.Fatalf("input doc was mutated: %+v", got)
	}
}

func TestApplyTopologyOperation_AttachDetachNetwork(t *testing.T) {
	doc := fixtureProjectDoc()

	next, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "attach-network", NetworkName: "n-office", Attach: &EndpointDoc{Device: "r2"},
	})
	if err != nil {
		t.Fatalf("attach-network: %v", err)
	}
	n := next.Topology.Networks[networkIndex(next.Topology.Networks, "n-office")]
	if len(n.Attach) != 2 {
		t.Fatalf("n-office not attached to r2: %+v", n.Attach)
	}

	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "detach-network", NetworkName: "n-office", Attach: &EndpointDoc{Device: "r1"},
	})
	if err != nil {
		t.Fatalf("detach-network: %v", err)
	}
	n = next.Topology.Networks[networkIndex(next.Topology.Networks, "n-office")]
	if len(n.Attach) != 1 || n.Attach[0].Device != "r2" {
		t.Fatalf("n-office attach after detach: %+v", n.Attach)
	}

	if _, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "attach-network", NetworkName: "n-office", Attach: &EndpointDoc{Device: "r1"},
	}); err == nil {
		t.Fatal("expected error attaching an already-attached device")
	}
	if _, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "detach-network", NetworkName: "n-office", Attach: &EndpointDoc{Device: "r2"},
	}); err == nil {
		t.Fatal("expected error detaching a device that isn't attached")
	}
}

func TestApplyTopologyOperation_UnionMembership(t *testing.T) {
	doc := fixtureProjectDoc()

	next, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "union-add-device", UnionName: "site-a", DeviceName: "r2",
	})
	if err != nil {
		t.Fatalf("union-add-device: %v", err)
	}
	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "union-add-network", UnionName: "site-a", NetworkName: "n-dmz",
	})
	if err != nil {
		t.Fatalf("union-add-network: %v", err)
	}
	u := next.Topology.Unions[unionIndex(next.Topology.Unions, "site-a")]
	if len(u.Devices) != 2 || len(u.Networks) != 2 {
		t.Fatalf("union after adds: %+v", u)
	}

	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "union-remove-device", UnionName: "site-a", DeviceName: "r1",
	})
	if err != nil {
		t.Fatalf("union-remove-device: %v", err)
	}
	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "union-remove-network", UnionName: "site-a", NetworkName: "n-office",
	})
	if err != nil {
		t.Fatalf("union-remove-network: %v", err)
	}
	u = next.Topology.Unions[unionIndex(next.Topology.Unions, "site-a")]
	if len(u.Devices) != 1 || u.Devices[0] != "r2" || len(u.Networks) != 1 || u.Networks[0] != "n-dmz" {
		t.Fatalf("union after removes: %+v", u)
	}

	if _, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "union-add-device", UnionName: "no-such-union", DeviceName: "r1",
	}); err == nil {
		t.Fatal("expected error for unknown union")
	}
}

func TestApplyTopologyOperation_LayoutPosition(t *testing.T) {
	doc := fixtureProjectDoc()
	doc.Topology.Links = []LinkDoc{{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}}

	next, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "set-device-position", DeviceName: "r1", Position: &LayoutPoint{X: 10, Y: 20},
	})
	if err != nil || next.Layout.Devices["r1"] != (LayoutPoint{X: 10, Y: 20}) {
		t.Fatalf("set-device-position: next=%+v err=%v", next.Layout.Devices, err)
	}

	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "set-network-position", NetworkName: "n-office", Position: &LayoutPoint{X: 30, Y: 40},
	})
	if err != nil || next.Layout.Networks["n-office"] != (LayoutPoint{X: 30, Y: 40}) {
		t.Fatalf("set-network-position: next=%+v err=%v", next.Layout.Networks, err)
	}

	waypoints := [][]LayoutPoint{{{X: 1, Y: 1}, {X: 2, Y: 2}}}
	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "set-link-waypoints", Link: &LinkDoc{A: EndpointDoc{Device: "r2"}, B: EndpointDoc{Device: "r1"}},
		Waypoints: waypoints,
	})
	if err != nil {
		t.Fatalf("set-link-waypoints: %v", err)
	}
	got := next.Layout.Links[layoutLinkKey("r1", "r2")]
	if len(got) != 1 || len(got[0]) != 2 {
		t.Fatalf("link waypoints not set: %+v", got)
	}

	next, err = applyTopologyOperation(next, topologyOperation{
		Kind: "set-camera", Camera: &LayoutCamera{X: 1, Y: 2, Z: 0.5},
	})
	if err != nil || next.Layout.Camera == nil || *next.Layout.Camera != (LayoutCamera{X: 1, Y: 2, Z: 0.5}) {
		t.Fatalf("set-camera: next=%+v err=%v", next.Layout.Camera, err)
	}

	if _, err := applyTopologyOperation(doc, topologyOperation{
		Kind: "set-device-position", DeviceName: "no-such-device", Position: &LayoutPoint{X: 1, Y: 1},
	}); err == nil {
		t.Fatal("expected error positioning an unknown device")
	}
}

func TestApplyTopologyOperation_UnknownKind(t *testing.T) {
	doc := fixtureProjectDoc()
	next, err := applyTopologyOperation(doc, topologyOperation{Kind: "not-a-real-command"})
	if err == nil {
		t.Fatal("expected error for unknown kind")
	}
	if b, _ := json.Marshal(next.Topology); string(b) != mustJSON(t, doc.Topology) {
		t.Fatal("doc changed on error")
	}
}

func TestApplyTopologyOperation_UnknownLink(t *testing.T) {
	doc := fixtureProjectDoc() // no links

	cases := []topologyOperation{
		{Kind: "set-link-filter", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}, Filter: &LinkFilterDoc{}},
		{Kind: "clear-link-filter", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		{Kind: "delete-link", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
		{Kind: "set-link-waypoints", Link: &LinkDoc{A: EndpointDoc{Device: "r1"}, B: EndpointDoc{Device: "r2"}}},
	}
	for _, op := range cases {
		if _, err := applyTopologyOperation(doc, op); err == nil {
			t.Fatalf("%s: expected error for a link that doesn't exist", op.Kind)
		}
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
