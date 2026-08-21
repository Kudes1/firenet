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
		},
		DefaultAction: rules.ActionDeny,
	}
	out := string(RenderRules(ds))

	if !strings.Contains(out, "-p tcp -m multiport --sports 443") {
		t.Fatalf("missing src-port-only match:\n%s", out)
	}
	if !strings.Contains(out, "-p tcp -m multiport --sports 1024-65535 -m multiport --dports 80,443") {
		t.Fatalf("missing combined src+dst port match:\n%s", out)
	}
}
