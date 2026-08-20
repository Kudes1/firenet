package app

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
)

const e2eTopology = `
devices:
  - {name: r1, kind: router, interfaces: [a0, b0]}
  - {name: r2, kind: router, interfaces: [a0, b0]}
subnets:
  - {name: office, cidr: 10.0.0.0/24, attach: [{device: r1, interface: a0}, {device: r2, interface: a0}]}
  - {name: dmz,    cidr: 10.0.1.0/24, attach: [{device: r1, interface: b0}, {device: r2, interface: b0}]}
`

const e2eRules = `
defaultAction: deny
rules:
  - {name: office-to-dmz-https, src: [office], dst: [dmz], proto: tcp, ports: ["443"], action: allow}
`

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestCompile_EndToEnd(t *testing.T) {
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(e2eTopology),
		RulesYAML:    []byte(e2eRules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d devices, want 2", len(out))
	}
	for _, d := range out {
		if !strings.Contains(d.RulesScript, "FIRENET-FWD") {
			t.Fatalf("%s: missing chain setup in rules script:\n%s", d.Name, d.RulesScript)
		}
		if !strings.Contains(d.RulesScript, "-p tcp") {
			t.Fatalf("%s: expected redundant router to carry the rule, got:\n%s", d.Name, d.RulesScript)
		}
		if !strings.Contains(d.IPSetsScript, "10.0.0.0/24") || !strings.Contains(d.IPSetsScript, "10.0.1.0/24") {
			t.Fatalf("%s: missing expected ipset members:\n%s", d.Name, d.IPSetsScript)
		}
	}
}

func TestCompile_InvalidTopologyFailsFast(t *testing.T) {
	_, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte("devices: [{name: r1, kind: bogus, interfaces: []}]"),
		RulesYAML:    []byte(e2eRules),
	})
	if err == nil {
		t.Fatal("expected error for invalid device kind")
	}
}
