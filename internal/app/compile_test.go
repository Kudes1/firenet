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
  - {name: r1, kind: router}
  - {name: r2, kind: router}
networks:
  - name: office
    subnets: [office]
    attach: [{device: r1, interface: a0}, {device: r2, interface: a0}]
  - name: dmz
    subnets: [dmz]
    attach: [{device: r1, interface: b0}, {device: r2, interface: b0}]
`

const e2eSubnets = `
subnets:
  - {name: office, cidr: 10.0.0.0/24}
  - {name: dmz, cidr: 10.0.1.0/24}
`

const e2eRules = `
defaultAction: deny
rules:
  - {name: office-to-dmz-https, src: [office], dst: [dmz], proto: tcp, dstPorts: ["443"], action: allow}
`

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestCompile_EndToEnd(t *testing.T) {
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(e2eTopology),
		SubnetsYAML:  []byte(e2eSubnets),
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
		TopologyYAML: []byte("devices: [{name: r1, kind: bogus}]"),
		SubnetsYAML:  []byte(e2eSubnets),
		RulesYAML:    []byte(e2eRules),
	})
	if err == nil {
		t.Fatal("expected error for invalid device kind")
	}
}

func TestLoadProject_OK(t *testing.T) {
	topo, err := LoadProject([]byte(e2eTopology), []byte(e2eSubnets))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Subnets) != 2 || len(topo.Networks) != 2 {
		t.Fatalf("unexpected project: %+v", topo)
	}
}

func TestLoadProject_SubnetInTwoNetworks(t *testing.T) {
	bad := `
devices:
  - {name: r1, kind: router}
networks:
  - {name: n1, subnets: [a], attach: [{device: r1}]}
  - {name: n2, subnets: [a], attach: [{device: r1}]}
`
	_, err := LoadProject([]byte(bad), []byte("subnets:\n  - {name: a, cidr: 10.0.0.0/24}\n"))
	if err == nil || !strings.Contains(err.Error(), "both network") {
		t.Fatalf("expected cross-file ownership error, got: %v", err)
	}
}

func TestLoadProject_UnknownNetworkSubnet(t *testing.T) {
	bad := `
devices:
  - {name: r1, kind: router}
networks:
  - {name: n1, subnets: [ghost], attach: [{device: r1}]}
`
	_, err := LoadProject([]byte(bad), []byte(e2eSubnets))
	if err == nil || !strings.Contains(err.Error(), "unknown subnet") {
		t.Fatalf("expected unknown subnet error, got: %v", err)
	}
}
