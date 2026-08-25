package diagnose

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/rules"
)

var (
	srcIP = netip.MustParseAddr("10.0.0.5")
	dstIP = netip.MustParseAddr("10.0.1.7")
)

func TestVerdictJumpTerminalSubchain(t *testing.T) {
	rs := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionAllow},
			{Name: "SUB", Default: rules.ActionDeny},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FWD", Comment: "to-sub", Action: rules.ActionJump, JumpTo: "SUB"},
		},
	}
	v := verdict(rs, Flow{Src: srcIP, Dst: dstIP}, "r1")
	if v.Action != rules.ActionDeny || v.MatchedRule != "to-sub" {
		t.Fatalf("verdict = %+v", v)
	}
	if !strings.Contains(v.Reason, "SUB") {
		t.Fatalf("reason must name the subchain: %q", v.Reason)
	}
}

func TestVerdictJumpReturnsBack(t *testing.T) {
	rs := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionAllow},
			{Name: "SUB", Default: rules.ActionReturn},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FWD", Comment: "to-sub", Action: rules.ActionJump, JumpTo: "SUB"},
			{Chain: "FWD", Comment: "final-allow", Action: rules.ActionAllow},
		},
	}
	v := verdict(rs, Flow{Src: srcIP, Dst: dstIP}, "r1")
	if v.Action != rules.ActionAllow || v.MatchedRule != "final-allow" {
		t.Fatalf("verdict = %+v", v)
	}
	if !strings.Contains(v.Reason, "возвращает") {
		t.Fatalf("reason must mention return: %q", v.Reason)
	}
}

func TestVerdictStepsTraceChainWalk(t *testing.T) {
	rs := compiler.DeviceRuleset{
		Device: "r1",
		Chains: []compiler.CompiledChain{
			{Name: "FWD", Primary: true, Position: rules.ChainTop, Default: rules.ActionAllow},
			{Name: "SUB", Default: rules.ActionDeny},
		},
		Rules: []compiler.CompiledRule{
			{Chain: "FWD", Comment: "to-sub", Action: rules.ActionJump, JumpTo: "SUB"},
		},
	}
	v := verdict(rs, Flow{Src: srcIP, Dst: dstIP}, "r1")
	if len(v.Steps) != 2 {
		t.Fatalf("want 2 steps (jump + terminal rule), got %d: %q", len(v.Steps), v.Steps)
	}
	if !strings.Contains(v.Steps[0], "to-sub") || !strings.Contains(v.Steps[0], "SUB") {
		t.Fatalf("step 0 must describe the jump: %q", v.Steps[0])
	}
	if !strings.Contains(v.Steps[1], "нет подходящих правил") || !strings.Contains(v.Steps[1], "SUB") {
		t.Fatalf("step 1 must describe the chain default: %q", v.Steps[1])
	}
	if v.Reason != strings.Join(v.Steps, "; ") {
		t.Fatalf("reason must stay the joined steps: %q vs %q", v.Reason, strings.Join(v.Steps, "; "))
	}
}

func TestVerdictNoChainsPassesThrough(t *testing.T) {
	v := verdict(compiler.DeviceRuleset{}, Flow{Src: netip.MustParseAddr("10.0.0.5"), Dst: netip.MustParseAddr("10.0.1.7")}, "ghost")
	if v.Action != rules.ActionAllow {
		t.Fatalf("want allow for an unmanaged device, got %+v", v)
	}
	if !strings.Contains(v.Reason, "без фильтрации") {
		t.Fatalf("reason must explain passthrough, got %q", v.Reason)
	}
}
