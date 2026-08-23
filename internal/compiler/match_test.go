package compiler

import (
	"net/netip"
	"testing"

	"github.com/kudes1/firenet/internal/rules"
)

var (
	officeIP = netip.MustParseAddr("10.0.0.5")
	dmzIP    = netip.MustParseAddr("10.0.1.7")
)

// matchFixture: ipset "fn_office" = 10.0.0.0/24, "fn_dmz" = 10.0.1.0/24,
// правило office-to-dmz tcp/443 allow, затем безусловное deny.
func matchFixture() DeviceRuleset {
	return DeviceRuleset{
		IPSets: []IPSet{
			{Name: "fn_office", DisplayName: "office", CIDRs: []string{"10.0.0.0/24"}},
			{Name: "fn_dmz", DisplayName: "dmz", CIDRs: []string{"10.0.1.0/24"}},
		},
		Rules: []CompiledRule{
			{Comment: "office-to-dmz", SrcSet: "fn_office", DstSet: "fn_dmz", Proto: rules.ProtoTCP, DstPorts: []string{"443"}, Action: rules.ActionAllow},
			{Comment: "catch-all-deny", Proto: rules.ProtoAny, Action: rules.ActionDeny},
		},
		DefaultAction: rules.ActionDeny,
	}
}

func TestMatchFlow(t *testing.T) {
	tests := []struct {
		name               string
		src                netip.Addr
		dst                netip.Addr
		proto              rules.Proto
		srcPorts, dstPorts []string
		want               string // Comment или "" (nil)
	}{
		{"exact match", officeIP, dmzIP, rules.ProtoTCP, nil, []string{"443"}, "office-to-dmz"},
		{"wrong port falls through to unconditional", officeIP, dmzIP, rules.ProtoTCP, nil, []string{"80"}, "catch-all-deny"},
		{"proto mismatch falls through", officeIP, dmzIP, rules.ProtoUDP, nil, []string{"443"}, "catch-all-deny"},
		{"empty flow proto matches any rule proto", officeIP, dmzIP, "", nil, nil, "office-to-dmz"},
		{"empty flow ports match port rule", officeIP, dmzIP, rules.ProtoTCP, nil, nil, "office-to-dmz"},
		{"src outside ipset skips set rule", netip.MustParseAddr("192.168.5.5"), dmzIP, rules.ProtoTCP, nil, []string{"443"}, "catch-all-deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MatchFlow(matchFixture(), tt.src, tt.dst, tt.proto, tt.srcPorts, tt.dstPorts)
			if tt.want == "" {
				if got != nil {
					t.Fatalf("want nil, got %+v", got)
				}
				return
			}
			if got == nil || got.Comment != tt.want {
				t.Fatalf("want rule %q, got %+v", tt.want, got)
			}
		})
	}
}

func TestMatchFlow_FirstMatchOrder(t *testing.T) {
	rs := matchFixture()
	got := MatchFlow(rs, officeIP, dmzIP, rules.ProtoAny, nil, nil)
	if got == nil || got.Comment != "office-to-dmz" {
		t.Fatalf("first-match order broken: %+v", got)
	}
}

func TestMatchFlow_LiteralAndUnconditional(t *testing.T) {
	rs := DeviceRuleset{
		Rules: []CompiledRule{
			{Comment: "host-block", SrcAddr: "10.0.0.9/32", Proto: rules.ProtoAny, Action: rules.ActionDeny},
			{Comment: "uncond", Action: rules.ActionAllow},
		},
		DefaultAction: rules.ActionDeny,
	}
	if r := MatchFlow(rs, netip.MustParseAddr("10.0.0.9"), dmzIP, "", nil, nil); r == nil || r.Comment != "host-block" {
		t.Fatalf("literal /32 must match contained host: %+v", r)
	}
	if r := MatchFlow(rs, officeIP, dmzIP, "", nil, nil); r == nil || r.Comment != "uncond" {
		t.Fatalf("empty SrcSet/DstSet is unconditional: %+v", r)
	}
}

func TestMatchFlow_PortRanges(t *testing.T) {
	rs := DeviceRuleset{
		Rules:         []CompiledRule{{Comment: "range", Proto: rules.ProtoTCP, DstPorts: []string{"1000:2000"}, Action: rules.ActionAllow}},
		DefaultAction: rules.ActionDeny,
	}
	if r := MatchFlow(rs, officeIP, dmzIP, rules.ProtoTCP, nil, []string{"1500"}); r == nil {
		t.Fatal("1500 inside 1000:2000 must match")
	}
	if r := MatchFlow(rs, officeIP, dmzIP, rules.ProtoTCP, nil, []string{"2500"}); r != nil {
		t.Fatalf("2500 outside range must not match: %+v", r)
	}
}

func TestMatchFlow_NoMatchReturnsNil(t *testing.T) {
	rs := DeviceRuleset{
		Rules:         []CompiledRule{{Comment: "x", SrcSet: "fn_missing", Action: rules.ActionAllow}},
		DefaultAction: rules.ActionDeny,
	}
	if got := MatchFlow(rs, officeIP, dmzIP, "", nil, nil); got != nil {
		t.Fatalf("unknown ipset name must not match, got %+v", got)
	}
}
