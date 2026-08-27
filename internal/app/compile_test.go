package app

import (
	"context"
	"io"
	"log/slog"
	"slices"
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
    attach: [{device: r1}, {device: r2}]
  - name: dmz
    subnets: [dmz]
    attach: [{device: r1}, {device: r2}]
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

const filteredChainTopology = `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
  - {name: o, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter:
      a-exports: [NA]
      b-exports: [NB]
  - a: {device: d}
    b: {device: o}
networks:
  - {name: NA, subnets: [a], attach: [{device: m}]}
  - {name: NB, subnets: [b], attach: [{device: d}]}
  - {name: NC, subnets: [c], attach: [{device: o}]}
`

const filteredChainSubnets = `
subnets:
  - {name: a, cidr: 10.0.10.0/24}
  - {name: b, cidr: 10.0.11.0/24}
  - {name: c, cidr: 10.0.12.0/24}
`

func TestCompile_FilteredLinkBlocksUnannouncedPair(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: blocked, src: [NA], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(filteredChainTopology),
		SubnetsYAML:  []byte(filteredChainSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("unannounced pair must place no rules, got devices: %v", names(out))
	}
}

func TestCompile_FilteredLinkKeepsAnnouncedPair(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: allowed, src: [NB], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(filteredChainTopology),
		SubnetsYAML:  []byte(filteredChainSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("announced pair places on %v, want %v", got, want)
	}
}

const chainedReExportTopology = `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
  - {name: o, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter: {a-exports: [NA], b-exports: [NB]}
  - a: {device: o}
    b: {device: d}
    filter: {a-exports: [NC], b-exports: [NB, NA]}
networks:
  - {name: NA, subnets: [a], attach: [{device: m}]}
  - {name: NB, subnets: [b], attach: [{device: d}]}
  - {name: NC, subnets: [c], attach: [{device: o}]}
`

const chainedReExportSubnets = `
subnets:
  - {name: a, cidr: 10.0.20.0/24}
  - {name: b, cidr: 10.0.21.0/24}
  - {name: c, cidr: 10.0.22.0/24}
`

// d re-exports NA (learned from m) toward o (b-exports includes NA on the
// o-d link) — o can now reach m. Nothing announces NC back toward m on the
// m-d link, so the reverse direction has no route at all: filtered links
// model per-direction route advertisement, not a symmetric ACL pair.
func TestCompile_ChainedReExportPlacesRuleForWorkingDirection(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: office-to-market, src: [NC], dst: [NA], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(chainedReExportTopology),
		SubnetsYAML:  []byte(chainedReExportSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	got := names(out)
	want := []string{"d", "m", "o"}
	if !slices.Equal(got, want) {
		t.Fatalf("chained re-export places on %v, want %v", got, want)
	}
}

func TestCompile_ChainedReExportPlacesNoRuleWithoutSymmetricAnnouncement(t *testing.T) {
	rules := `
defaultAction: deny
rules:
  - {name: market-to-office, src: [NA], dst: [NC], action: allow}
`
	out, err := Compile(context.Background(), discardLogger(), CompileOptions{
		TopologyYAML: []byte(chainedReExportTopology),
		SubnetsYAML:  []byte(chainedReExportSubnets),
		RulesYAML:    []byte(rules),
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("market has no route back to office without a symmetric announcement, got devices: %v", names(out))
	}
}

func names(out []CompiledDevice) []string {
	var s []string
	for _, d := range out {
		s = append(s, d.Name)
	}
	return s
}
