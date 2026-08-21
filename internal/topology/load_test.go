package topology

import (
	"strings"
	"testing"
)

func TestLoad_TopologyYAML(t *testing.T) {
	in := `
devices:
  - {name: r1, kind: router}
links:
  - a: {device: r1}
    b: {device: r2}
networks:
  - name: office
    subnets: [a, b]
    attach:
      - {device: r1, interface: lan0}
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Devices) != 1 || len(topo.Links) != 1 {
		t.Fatalf("unexpected devices/links: %+v", topo)
	}
	n := topo.Networks["office"]
	if n.Name != "office" || len(n.Subnets) != 2 || len(n.Attach) != 1 || n.Attach[0].Device != "r1" {
		t.Fatalf("unexpected network: %+v", n)
	}
}

func TestLoad_RejectsUnknownFields(t *testing.T) {
	in := `
subnets:
  - {name: legacy, cidr: 10.0.0.0/24}
`
	if _, err := Load(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for unknown field (legacy topology format)")
	}
}

func TestLoad_DuplicateNetwork(t *testing.T) {
	in := `
networks:
  - {name: x, subnets: [a]}
  - {name: x, subnets: [b]}
`
	if _, err := Load(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for duplicate network")
	}
}

func TestLoadSubnets_OK(t *testing.T) {
	in := `
subnets:
  - {name: a, cidr: 10.0.0.0/24}
  - {name: b, cidr: 10.0.1.0/24}
`
	subnets, err := LoadSubnets(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(subnets) != 2 || subnets["a"].CIDR.String() != "10.0.0.0/24" {
		t.Fatalf("unexpected subnets: %+v", subnets)
	}
}

func TestLoadSubnets_InvalidCIDR(t *testing.T) {
	in := `
subnets:
  - {name: bad, cidr: not-a-cidr}
`
	if _, err := LoadSubnets(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for invalid cidr")
	}
}

func TestLoadSubnets_DuplicateName(t *testing.T) {
	in := `
subnets:
  - {name: a, cidr: 10.0.0.0/24}
  - {name: a, cidr: 10.0.1.0/24}
`
	if _, err := LoadSubnets(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for duplicate subnet")
	}
}
