package rules

import (
	"net/netip"
	"testing"

	"github.com/kudes1/firenet/internal/topology"
)

func testTopology(t *testing.T) *topology.Topology {
	t.Helper()
	prefix, err := netip.ParsePrefix("10.0.0.0/24")
	if err != nil {
		t.Fatal(err)
	}
	return &topology.Topology{
		Devices: map[string]topology.Device{
			"r1": {Name: "r1", Kind: topology.DeviceRouter, Interfaces: []string{"lan0"}},
		},
		Subnets: map[string]topology.Subnet{
			"office": {Name: "office", CIDR: prefix, AttachedTo: []topology.InterfaceRef{{Device: "r1", Interface: "lan0"}}},
		},
		Zones: map[string]topology.Zone{
			"internal": {Name: "internal", Subnets: []string{"office"}},
		},
	}
}

func baseRule() Rule {
	return Rule{Name: "r", Src: []string{"office"}, Dst: []string{Any}, Proto: ProtoAny, Action: ActionAllow}
}

func TestValidate_OK(t *testing.T) {
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{baseRule()}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_ZoneEndpointOK(t *testing.T) {
	r := baseRule()
	r.Src = []string{"internal"}
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_UnknownSrc(t *testing.T) {
	r := baseRule()
	r.Src = []string{"nope"}
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for unknown src")
	}
}

func TestValidate_InvalidProto(t *testing.T) {
	r := baseRule()
	r.Proto = "gre"
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid proto")
	}
}

func TestValidate_PortsOnlyForTCPUDP(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoICMP
	r.Ports = []string{"80"}
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for ports on icmp rule")
	}
}

func TestValidate_PortSpecs(t *testing.T) {
	cases := []struct {
		spec    string
		wantErr bool
	}{
		{"80", false},
		{"1000-2000", false},
		{"0", true},
		{"70000", true},
		{"2000-1000", true},
		{"abc", true},
	}
	for _, c := range cases {
		r := baseRule()
		r.Proto = ProtoTCP
		r.Ports = []string{c.spec}
		pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{r}}
		err := pol.Validate(testTopology(t))
		if (err != nil) != c.wantErr {
			t.Errorf("port %q: err=%v, wantErr=%v", c.spec, err, c.wantErr)
		}
	}
}

func TestValidate_DuplicateRuleName(t *testing.T) {
	pol := &Policy{DefaultAction: ActionDeny, Rules: []Rule{baseRule(), baseRule()}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for duplicate rule name")
	}
}

func TestValidate_InvalidDefaultAction(t *testing.T) {
	pol := &Policy{DefaultAction: "maybe"}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid defaultAction")
	}
}
