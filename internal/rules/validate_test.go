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
			"r1": {Name: "r1", Kind: topology.DeviceRouter},
		},
		Subnets: map[string]topology.Subnet{
			"office": {Name: "office", CIDR: prefix},
		},
		Networks: map[string]topology.Network{
			"internal": {Name: "internal", Subnets: []string{"office"}, Attach: []topology.Endpoint{{Device: "r1"}}},
		},
	}
}

func baseRule() Rule {
	return Rule{Name: "r", Src: []string{"office"}, Dst: []string{Any}, Proto: ProtoAny, Action: ActionAllow}
}

func TestValidate_OK(t *testing.T) {
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{baseRule()}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_NetworkEndpointOK(t *testing.T) {
	r := baseRule()
	r.Src = []string{"internal"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_SetEndpointOK(t *testing.T) {
	topo := testTopology(t)
	addr, _ := netip.ParseAddr("10.0.0.9")
	topo.Sets = map[string]topology.Set{
		"blocked": {Name: "blocked", Subnets: []string{"office"}, Addresses: []netip.Prefix{netip.PrefixFrom(addr, addr.BitLen())}},
	}
	r := baseRule()
	r.Src = []string{"blocked"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_LiteralEndpointOK(t *testing.T) {
	for _, ep := range []string{"10.0.0.5", "10.0.0.0/24", "10.0.0.9/32"} {
		r := baseRule()
		r.Src = []string{ep}
		pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
		if err := pol.Validate(testTopology(t)); err != nil {
			t.Errorf("literal endpoint %q: unexpected error: %v", ep, err)
		}
	}
}

func TestValidate_InvalidLiteralEndpoint(t *testing.T) {
	for _, ep := range []string{"10.0.0", "300.1.1.1", "10.0.0.5/33", "10.0.0.5/24/x", "::1", "fe80::/64"} {
		r := baseRule()
		r.Src = []string{ep}
		pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
		if err := pol.Validate(testTopology(t)); err == nil {
			t.Errorf("literal endpoint %q: expected error", ep)
		}
	}
}

func TestValidate_UnknownSrc(t *testing.T) {
	r := baseRule()
	r.Src = []string{"nope"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for unknown src")
	}
}

func TestValidate_InvalidProto(t *testing.T) {
	r := baseRule()
	r.Proto = "gre"
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid proto")
	}
}

func TestValidate_PortsOnlyForTCPUDP(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoICMP
	r.DstPorts = []string{"80"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for ports on icmp rule")
	}
}

func TestValidate_SrcPortsOnlyForTCPUDP(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoICMP
	r.SrcPorts = []string{"80"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for src ports on icmp rule")
	}
}

func TestValidate_SrcPortSpecs(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoTCP
	r.SrcPorts = []string{"1024-65535"}
	r.DstPorts = []string{"443"}
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
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
		{"80-80", true},
		{"abc", true},
	}
	for _, c := range cases {
		r := baseRule()
		r.Proto = ProtoTCP
		r.DstPorts = []string{c.spec}
		pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
		err := pol.Validate(testTopology(t))
		if (err != nil) != c.wantErr {
			t.Errorf("port %q: err=%v, wantErr=%v", c.spec, err, c.wantErr)
		}
	}
}

func TestValidate_DuplicateRuleName(t *testing.T) {
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{baseRule(), baseRule()}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for duplicate rule name")
	}
}

func TestValidate_ReturnActionOK(t *testing.T) {
	r := baseRule()
	r.Action = ActionReturn
	pol := &Policy{DefaultAction: ActionReturn, ChainName: "FIRENET-FWD", ChainPosition: ChainTop, Rules: []Rule{r}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_InvalidDefaultAction(t *testing.T) {
	pol := &Policy{DefaultAction: "maybe"}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid defaultAction")
	}
}

func TestValidate_InvalidChainName(t *testing.T) {
	cases := []string{"", "bad name", "toolongtoolongtoolongtoolong1"}
	for _, name := range cases {
		pol := &Policy{DefaultAction: ActionDeny, ChainName: name, ChainPosition: ChainTop, Rules: []Rule{baseRule()}}
		if err := pol.Validate(testTopology(t)); err == nil {
			t.Errorf("chainName %q: expected error", name)
		}
	}
}

func TestValidate_InvalidChainPosition(t *testing.T) {
	pol := &Policy{DefaultAction: ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: "middle", Rules: []Rule{baseRule()}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid chainPosition")
	}
}
