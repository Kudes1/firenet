package projectdoc

import (
	"encoding/json"
	"testing"
)

func TestLayoutDocRoundTrip(t *testing.T) {
	const raw = `{"devices":{"r1":{"x":10,"y":20}},"networks":{"main":{"x":5,"y":6}},"links":{"office|r1":[[{"x":1,"y":2},{"x":3,"y":4}]]},"camera":{"x":1,"y":2,"z":0.5}}`

	var doc LayoutDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if doc.Devices["r1"] != (LayoutPoint{X: 10, Y: 20}) {
		t.Fatalf("got device point %+v", doc.Devices["r1"])
	}
	if doc.Camera == nil || *doc.Camera != (LayoutCamera{X: 1, Y: 2, Z: 0.5}) {
		t.Fatalf("got camera %+v", doc.Camera)
	}
	if len(doc.Links["office|r1"]) != 1 || len(doc.Links["office|r1"][0]) != 2 {
		t.Fatalf("got links %+v", doc.Links)
	}

	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var roundTripped LayoutDoc
	if err := json.Unmarshal(out, &roundTripped); err != nil {
		t.Fatalf("unmarshal round-tripped: %v", err)
	}
	if roundTripped.Devices["r1"] != doc.Devices["r1"] {
		t.Fatalf("round-trip lost device point: %+v", roundTripped.Devices["r1"])
	}
}

func TestLayoutDocEmpty(t *testing.T) {
	var doc LayoutDoc
	if err := json.Unmarshal([]byte("{}"), &doc); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if doc.Devices != nil || doc.Camera != nil {
		t.Fatalf("expected zero-value LayoutDoc, got %+v", doc)
	}
}
