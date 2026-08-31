package topology

import (
	"slices"
	"strings"
	"testing"
)

func TestLoad_FilteredLink(t *testing.T) {
	in := `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
links:
  - a: {device: m}
    b: {device: d}
    filter:
      a-exports: [MARKET, mr-extra]
      b-exports: [MAIN]
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	l := topo.Links[0]
	if l.Filter == nil {
		t.Fatal("expected filter on link")
	}
	if !slices.Equal(l.Filter.AExports, []string{"MARKET", "mr-extra"}) || !slices.Equal(l.Filter.BExports, []string{"MAIN"}) {
		t.Fatalf("unexpected filter: %+v", l.Filter)
	}
}

func TestLoad_PlainLinkHasNoFilter(t *testing.T) {
	in := `
devices:
  - {name: m, kind: router}
  - {name: d, kind: router}
links:
  - a: {device: m}
    b: {device: d}
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if topo.Links[0].Filter != nil {
		t.Fatal("plain link must have nil filter")
	}
}

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
      - {device: r1}
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

func TestLoad_Unions(t *testing.T) {
	in := `
devices:
  - {name: r1, kind: router}
links: []
networks:
  - {name: net1, subnets: [a]}
unions:
  - name: office
    description: Главный офис
    devices:  [r1]
    networks: [net1]
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	s, ok := topo.Unions["office"]
	if !ok {
		t.Fatalf("union office missing: %+v", topo.Unions)
	}
	if s.Description != "Главный офис" || !slices.Equal(s.Devices, []string{"r1"}) || !slices.Equal(s.Networks, []string{"net1"}) {
		t.Fatalf("unexpected union: %+v", s)
	}
}

func TestLoad_TopologyWithoutUnionsStillLoads(t *testing.T) {
	in := "devices:\n  - {name: r1, kind: router}\nlinks: []\nnetworks: []\nsets: []\n"
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(topo.Unions) != 0 {
		t.Fatalf("expected no unions, got %+v", topo.Unions)
	}
}

func TestLoad_DuplicateUnionName(t *testing.T) {
	in := `
devices: []
links: []
networks: []
unions:
  - {name: office}
  - {name: office}
`
	if _, err := Load(strings.NewReader(in)); err == nil || !strings.Contains(err.Error(), "duplicate union") {
		t.Fatalf("want duplicate union error, got %v", err)
	}
}

func TestLoad_Sets(t *testing.T) {
	in := `
sets:
  - name: blocked
    subnets: [a, b]
    addresses: [10.1.2.3, 10.1.2.4/32]
  - name: hosts-only
    addresses: [10.9.9.9]
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	s := topo.Sets["blocked"]
	if s.Name != "blocked" || len(s.Subnets) != 2 {
		t.Fatalf("unexpected set subnets: %+v", s)
	}
	want := []string{"10.1.2.3/32", "10.1.2.4/32"}
	if len(s.Addresses) != len(want) {
		t.Fatalf("got %d addresses, want %d: %+v", len(s.Addresses), len(want), s.Addresses)
	}
	for i, w := range want {
		if got := s.Addresses[i].String(); got != w {
			t.Fatalf("address[%d] = %q, want %q", i, got, w)
		}
	}
	if s := topo.Sets["hosts-only"]; len(s.Subnets) != 0 || s.Addresses[0].String() != "10.9.9.9/32" {
		t.Fatalf("unexpected hosts-only set: %+v", s)
	}
}

func TestLoad_SetInvalidAddress(t *testing.T) {
	in := `
sets:
  - {name: bad, addresses: [not-an-ip]}
`
	if _, err := Load(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for invalid address")
	}
}

func TestLoad_DuplicateSet(t *testing.T) {
	in := `
sets:
  - {name: x, addresses: [10.0.0.1]}
  - {name: x, addresses: [10.0.0.2]}
`
	if _, err := Load(strings.NewReader(in)); err == nil {
		t.Fatal("expected error for duplicate set")
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

func TestLoad_DescriptionFields(t *testing.T) {
	in := `
devices:
  - {name: r1, kind: router, description: "граничный маршрутизатор"}
networks:
  - {name: n1, subnets: [a], description: "офисная сеть"}
sets:
  - {name: s1, subnets: [a], description: "блоклист"}
`
	topo, err := Load(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if topo.Devices["r1"].Description != "граничный маршрутизатор" {
		t.Fatalf("unexpected device description: %+v", topo.Devices["r1"])
	}
	if topo.Networks["n1"].Description != "офисная сеть" {
		t.Fatalf("unexpected network description: %+v", topo.Networks["n1"])
	}
	if topo.Sets["s1"].Description != "блоклист" {
		t.Fatalf("unexpected set description: %+v", topo.Sets["s1"])
	}
}

func TestLoadSubnets_WithDescription(t *testing.T) {
	in := `
subnets:
  - {name: a, cidr: 10.0.0.0/24, description: "офисный сегмент"}
`
	subnets, err := LoadSubnets(strings.NewReader(in))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if subnets["a"].Description != "офисный сегмент" {
		t.Fatalf("unexpected description: %+v", subnets["a"])
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
