package render

import (
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/rules"
)

func TestRenderIPSets(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		IPSets: []compiler.IPSet{
			{Name: "fn_deadbeef", DisplayName: "office", CIDRs: []string{"10.0.0.0/24"}},
		},
	}
	out := string(RenderIPSets(ds))
	if !strings.Contains(out, "create fn_deadbeef hash:net -exist") {
		t.Fatalf("missing create line: %s", out)
	}
	if !strings.Contains(out, "add fn_deadbeef 10.0.0.0/24") {
		t.Fatalf("missing add line: %s", out)
	}
}

func TestRenderRules_StructureAndOrder(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionDeny}},
		Rules: []compiler.CompiledRule{
			{Chain: "FIRENET-FWD", Comment: "allow-https", SrcSet: "fn_a", DstSet: "fn_b", Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
	}
	out := string(RenderRules(ds))

	establishedIdx := strings.Index(out, "ESTABLISHED,RELATED")
	ruleIdx := strings.Index(out, "fn_a")
	defaultIdx := strings.LastIndex(out, "-j DROP")

	if establishedIdx == -1 || ruleIdx == -1 || defaultIdx == -1 {
		t.Fatalf("missing expected lines in output:\n%s", out)
	}
	if !(establishedIdx < ruleIdx && ruleIdx < defaultIdx) {
		t.Fatalf("rules out of order (conntrack < specific < default), got:\n%s", out)
	}
	if !strings.Contains(out, "FIRENET-FWD") {
		t.Fatalf("expected dedicated chain name in output:\n%s", out)
	}
	if !strings.Contains(out, "-m set --match-set fn_a src") || !strings.Contains(out, "-m set --match-set fn_b dst") {
		t.Fatalf("missing ipset match clauses:\n%s", out)
	}
	if !strings.Contains(out, "-p tcp -m multiport --dports 443") {
		t.Fatalf("missing proto/port match:\n%s", out)
	}
}

func TestRenderRules_SrcAndDstPorts(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionDeny}},
		Rules: []compiler.CompiledRule{
			{Chain: "FIRENET-FWD", Comment: "reverse-https", SrcSet: "fn_b", DstSet: "fn_a", Proto: rules.ProtoTCP, SrcPorts: []string{"443"}, Action: rules.ActionAllow},
			{Chain: "FIRENET-FWD", Comment: "both-sides", Proto: rules.ProtoTCP, SrcPorts: []string{"1024-65535"}, DstPorts: []string{"80", "443"}, Action: rules.ActionAllow},
			{Chain: "FIRENET-FWD", Comment: "dst-range", Proto: rules.ProtoUDP, DstPorts: []string{"5000-5010"}, Action: rules.ActionAllow},
		},
	}
	out := string(RenderRules(ds))

	if !strings.Contains(out, "-p tcp -m multiport --sports 443") {
		t.Fatalf("missing src-port-only match:\n%s", out)
	}
	if !strings.Contains(out, "-p tcp -m multiport --sports 1024:65535 -m multiport --dports 80,443") {
		t.Fatalf("missing combined src+dst port match:\n%s", out)
	}
	if !strings.Contains(out, "-p udp -m multiport --dports 5000:5010") {
		t.Fatalf("missing dst-port range match:\n%s", out)
	}
}

func TestRenderRules_LiteralAddressMatch(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionDeny}},
		Rules: []compiler.CompiledRule{
			{Chain: "FIRENET-FWD", Comment: "host-ssh", SrcAddr: "10.0.0.5/32", DstAddr: "10.0.1.0/24", Proto: rules.ProtoTCP, DstPorts: []string{"22"}, Action: rules.ActionAllow},
		},
	}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "-s 10.0.0.5/32") || !strings.Contains(out, "-d 10.0.1.0/24") {
		t.Fatalf("missing literal address match clauses:\n%s", out)
	}
	if strings.Contains(out, "--match-set") {
		t.Fatalf("literal addresses must not be rendered as ipset matches:\n%s", out)
	}
}

func TestRenderRules_ChainPositionTop(t *testing.T) {
	ds := compiler.DeviceRuleset{Device: "r1", Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionDeny}}}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "iptables -I FORWARD -j FIRENET-FWD") {
		t.Fatalf("expected -I FORWARD jump for top position:\n%s", out)
	}
	if strings.Contains(out, "-A FORWARD -j FIRENET-FWD") {
		t.Fatalf("did not expect -A FORWARD jump for top position:\n%s", out)
	}
}

func TestRenderRules_ChainPositionBottom(t *testing.T) {
	ds := compiler.DeviceRuleset{Device: "r1", Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainBottom, Default: rules.ActionDeny}}}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "iptables -A FORWARD -j FIRENET-FWD") {
		t.Fatalf("expected -A FORWARD jump for bottom position:\n%s", out)
	}
	if strings.Contains(out, "-I FORWARD -j FIRENET-FWD") {
		t.Fatalf("did not expect -I FORWARD jump for bottom position:\n%s", out)
	}
}

func TestRenderRules_ReturnAction(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{{Name: "FIRENET-FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionReturn}},
		Rules:  []compiler.CompiledRule{{Chain: "FIRENET-FWD", Comment: "bypass", Action: rules.ActionReturn}},
	}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "iptables -A FIRENET-FWD -j RETURN\n") {
		t.Fatalf("expected rule with return action to render as RETURN:\n%s", out)
	}
	if strings.Count(out, "-j RETURN") != 2 {
		t.Fatalf("expected exactly 2 RETURN targets (rule + default):\n%s", out)
	}
}

func TestRenderRulesMultiChain(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FIRENET-FWD", Primary: true, Default: rules.ActionDeny},
			{Name: "FIRENET-RESTRICTED", Default: rules.ActionDeny},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FIRENET-FWD", Action: rules.ActionJump, JumpTo: "FIRENET-RESTRICTED"},
			{Chain: "FIRENET-RESTRICTED", Action: rules.ActionAllow},
		},
	}
	out := string(RenderRules(ds))
	for _, want := range []string{
		"iptables -N FIRENET-FWD",
		"iptables -N FIRENET-RESTRICTED",
		"iptables -I FORWARD -j FIRENET-FWD",
		"iptables -A FIRENET-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
		"iptables -A FIRENET-FWD -j FIRENET-RESTRICTED",
		"iptables -A FIRENET-RESTRICTED -j ACCEPT",
		"iptables -A FIRENET-RESTRICTED -j DROP",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "iptables -I FORWARD -j FIRENET-RESTRICTED") {
		t.Fatal("secondary chain must not be wired into FORWARD")
	}
}

func TestRenderRules_CustomChainName(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{{Name: "MY-CHAIN", Primary: true, Position: rules.ChainTop, Default: rules.ActionDeny}},
		Rules:  []compiler.CompiledRule{{Chain: "MY-CHAIN", Comment: "allow-https", Action: rules.ActionAllow}},
	}
	out := string(RenderRules(ds))
	if strings.Contains(out, "FIRENET-FWD") {
		t.Fatalf("expected default chain name not to appear when a custom one is set:\n%s", out)
	}
	if !strings.Contains(out, "iptables -N MY-CHAIN") || !strings.Contains(out, "iptables -I FORWARD -j MY-CHAIN") {
		t.Fatalf("expected custom chain name throughout the script:\n%s", out)
	}
}
