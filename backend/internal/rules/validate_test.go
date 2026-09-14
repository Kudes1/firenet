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
			"office":    {Name: "office", CIDR: prefix},
			"dangerous": {Name: "dangerous", CIDR: netip.MustParsePrefix("10.0.1.0/24")},
			"dns":       {Name: "dns", CIDR: netip.MustParsePrefix("10.0.2.0/24")},
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
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{baseRule()}}}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_NetworkEndpointOK(t *testing.T) {
	r := baseRule()
	r.Src = []string{"internal"}
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
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
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(topo); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_LiteralEndpointOK(t *testing.T) {
	for _, ep := range []string{"10.0.0.5", "10.0.0.0/24", "10.0.0.9/32"} {
		r := baseRule()
		r.Src = []string{ep}
		pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
		if err := pol.Validate(testTopology(t)); err != nil {
			t.Errorf("literal endpoint %q: unexpected error: %v", ep, err)
		}
	}
}

func TestValidate_InvalidLiteralEndpoint(t *testing.T) {
	for _, ep := range []string{"10.0.0", "300.1.1.1", "10.0.0.5/33", "10.0.0.5/24/x", "::1", "fe80::/64"} {
		r := baseRule()
		r.Src = []string{ep}
		pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
		if err := pol.Validate(testTopology(t)); err == nil {
			t.Errorf("literal endpoint %q: expected error", ep)
		}
	}
}

func TestValidate_UnknownSrc(t *testing.T) {
	r := baseRule()
	r.Src = []string{"nope"}
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for unknown src")
	}
}

func TestValidate_InvalidProto(t *testing.T) {
	r := baseRule()
	r.Proto = "gre"
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid proto")
	}
}

func TestValidate_PortsOnlyForTCPUDP(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoICMP
	r.DstPorts = []string{"80"}
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for ports on icmp rule")
	}
}

func TestValidate_SrcPortsOnlyForTCPUDP(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoICMP
	r.SrcPorts = []string{"80"}
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for src ports on icmp rule")
	}
}

func TestValidate_SrcPortSpecs(t *testing.T) {
	r := baseRule()
	r.Proto = ProtoTCP
	r.SrcPorts = []string{"1024-65535"}
	r.DstPorts = []string{"443"}
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
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
		pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{r}}}}
		err := pol.Validate(testTopology(t))
		if (err != nil) != c.wantErr {
			t.Errorf("port %q: err=%v, wantErr=%v", c.spec, err, c.wantErr)
		}
	}
}

func TestValidate_DuplicateRuleName(t *testing.T) {
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{baseRule(), baseRule()}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for duplicate rule name")
	}
}

func TestValidate_ReturnActionOK(t *testing.T) {
	r := baseRule()
	r.Action = ActionReturn
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionReturn, ChainPosition: ChainTop, Rules: []Rule{r}}}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidate_InvalidDefaultAction(t *testing.T) {
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: "maybe"}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid defaultAction")
	}
}

func TestValidate_InvalidChainName(t *testing.T) {
	cases := []string{"", "bad name", "toolongtoolongtoolongtoolong1"}
	for _, name := range cases {
		pol := &Policy{Chains: []Chain{{Name: name, DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{baseRule()}}}}
		if err := pol.Validate(testTopology(t)); err == nil {
			t.Errorf("chainName %q: expected error", name)
		}
	}
}

func TestValidate_InvalidChainPosition(t *testing.T) {
	pol := &Policy{Chains: []Chain{{Name: "FIRENET-FWD", DefaultAction: ActionDeny, ChainPosition: "middle", Rules: []Rule{baseRule()}}}}
	if err := pol.Validate(testTopology(t)); err == nil {
		t.Fatal("expected error for invalid chainPosition")
	}
}

func jumpRule(name string, action Action, jumpTo string) Rule {
	return Rule{Name: name, Src: []string{"dangerous"}, Dst: []string{"dns"}, Proto: ProtoAny, Action: action, JumpTo: jumpTo}
}

func TestValidateJumpErrors(t *testing.T) {
	topo := testTopology(t)
	cases := []struct {
		name string
		pol  *Policy
	}{
		{"jump without target", &Policy{Chains: []Chain{{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("r", ActionJump, "")}}}}},
		{"jumpTo without jump", &Policy{Chains: []Chain{{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("r", ActionAllow, "B")}}}}},
		{"unknown target", &Policy{Chains: []Chain{{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("r", ActionJump, "NOPE")}}}}},
		{"self jump", &Policy{Chains: []Chain{{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("r", ActionJump, "A")}}}}},
		{"cycle", &Policy{Chains: []Chain{
			{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("r", ActionJump, "B")}},
			{Name: "B", DefaultAction: ActionDeny, Rules: []Rule{jumpRule("q", ActionJump, "A")}},
		}}},
		{"position on secondary", &Policy{Chains: []Chain{
			{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{}},
			{Name: "B", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{}},
		}}},
		{"dup chain names", &Policy{Chains: []Chain{
			{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{}},
			{Name: "A", DefaultAction: ActionDeny, Rules: []Rule{}},
		}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.pol.Validate(topo); err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
	t.Run("no chains", func(t *testing.T) {
		if err := (&Policy{}).Validate(topo); err == nil {
			t.Fatal("expected validation error for no chains")
		}
	})
}

func TestValidateValidJumpChain(t *testing.T) {
	pol := &Policy{Chains: []Chain{
		{Name: "A", DefaultAction: ActionDeny, ChainPosition: ChainTop, Rules: []Rule{jumpRule("r", ActionJump, "B")}},
		{Name: "B", DefaultAction: ActionDeny, Rules: []Rule{{Name: "dns-ok", Src: []string{"dangerous"}, Dst: []string{"dns"}, Proto: ProtoUDP, DstPorts: []string{"53"}, Action: ActionAllow}}},
	}}
	if err := pol.Validate(testTopology(t)); err != nil {
		t.Fatal(err)
	}
}
