package lint

import (
	"encoding/json"
	"testing"
)

func TestFinding_JSONShape(t *testing.T) {
	f := Finding{Severity: SeverityWarning, Chain: "FIRENET-FWD", Rules: []string{"a", "b"}, Message: "msg"}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"severity":"warning","chain":"FIRENET-FWD","rules":["a","b"],"message":"msg"}`
	if string(b) != want {
		t.Fatalf("got %s, want %s", b, want)
	}
}

func TestFinding_JSONOmitsEmptyRules(t *testing.T) {
	f := Finding{Severity: SeverityInfo, Chain: "ORPHAN", Message: "unused chain"}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"severity":"info","chain":"ORPHAN","message":"unused chain"}`
	if string(b) != want {
		t.Fatalf("got %s, want %s", b, want)
	}
}
