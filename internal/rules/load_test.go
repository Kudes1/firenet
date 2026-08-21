package rules

import (
	"strings"
	"testing"
)

func TestLoad_RuleComment(t *testing.T) {
	in := `
defaultAction: deny
rules:
  - name: db-access
    comment: доступ к БД
    src: [A]
    dst: [B]
    action: allow
`
	pol, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(pol.Rules) != 1 {
		t.Fatalf("got %d rules, want 1", len(pol.Rules))
	}
	if pol.Rules[0].Comment != "доступ к БД" {
		t.Fatalf("Comment = %q, want %q", pol.Rules[0].Comment, "доступ к БД")
	}
}
