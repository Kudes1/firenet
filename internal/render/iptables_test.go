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
		Rules: []compiler.CompiledRule{
			{Comment: "allow-https", SrcSet: "fn_a", DstSet: "fn_b", Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
		},
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
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
		Rules: []compiler.CompiledRule{
			{Comment: "reverse-https", SrcSet: "fn_b", DstSet: "fn_a", Proto: rules.ProtoTCP, SrcPorts: []string{"443"}, Action: rules.ActionAllow},
			{Comment: "both-sides", Proto: rules.ProtoTCP, SrcPorts: []string{"1024-65535"}, DstPorts: []string{"80", "443"}, Action: rules.ActionAllow},
			{Comment: "dst-range", Proto: rules.ProtoUDP, DstPorts: []string{"5000-5010"}, Action: rules.ActionAllow},
		},
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
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
		Rules: []compiler.CompiledRule{
			{Comment: "host-ssh", SrcAddr: "10.0.0.5/32", DstAddr: "10.0.1.0/24", Proto: rules.ProtoTCP, DstPorts: []string{"22"}, Action: rules.ActionAllow},
		},
		DefaultAction: rules.ActionDeny,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
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
	ds := compiler.DeviceRuleset{Device: "r1", DefaultAction: rules.ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: rules.ChainTop}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "iptables -I FORWARD -j FIRENET-FWD") {
		t.Fatalf("expected -I FORWARD jump for top position:\n%s", out)
	}
	if strings.Contains(out, "-A FORWARD -j FIRENET-FWD") {
		t.Fatalf("did not expect -A FORWARD jump for top position:\n%s", out)
	}
}

func TestRenderRules_ChainPositionBottom(t *testing.T) {
	ds := compiler.DeviceRuleset{Device: "r1", DefaultAction: rules.ActionDeny, ChainName: "FIRENET-FWD", ChainPosition: rules.ChainBottom}
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
		Device:        "r1",
		Rules:         []compiler.CompiledRule{{Comment: "bypass", Action: rules.ActionReturn}},
		DefaultAction: rules.ActionReturn,
		ChainName:     "FIRENET-FWD",
		ChainPosition: rules.ChainTop,
	}
	out := string(RenderRules(ds))
	if !strings.Contains(out, "iptables -A FIRENET-FWD -j RETURN\n") {
		t.Fatalf("expected rule with return action to render as RETURN:\n%s", out)
	}
	if strings.Count(out, "-j RETURN") != 2 {
		t.Fatalf("expected exactly 2 RETURN targets (rule + default):\n%s", out)
	}
}

func TestRenderRules_CustomChainName(t *testing.T) {
	ds := compiler.DeviceRuleset{
		Device:        "r1",
		Rules:         []compiler.CompiledRule{{Comment: "allow-https", Action: rules.ActionAllow}},
		DefaultAction: rules.ActionDeny,
		ChainName:     "MY-CHAIN",
		ChainPosition: rules.ChainTop,
	}
	out := string(RenderRules(ds))
	if strings.Contains(out, "FIRENET-FWD") {
		t.Fatalf("expected default chain name not to appear when a custom one is set:\n%s", out)
	}
	if !strings.Contains(out, "iptables -N MY-CHAIN") || !strings.Contains(out, "iptables -I FORWARD -j MY-CHAIN") {
		t.Fatalf("expected custom chain name throughout the script:\n%s", out)
	}
}
