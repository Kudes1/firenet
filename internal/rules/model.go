// Package rules models the filtering policy: a priority-ordered list of
// rules matching traffic by named subnets/zones from internal/topology.
package rules

// Action is what a matching rule does with traffic.
type Action string

const (
	ActionAllow Action = "allow"
	ActionDeny  Action = "deny"
)

// Proto is the transport protocol a rule matches.
type Proto string

const (
	ProtoAny  Proto = "any"
	ProtoTCP  Proto = "tcp"
	ProtoUDP  Proto = "udp"
	ProtoICMP Proto = "icmp"
)

// Any is the reserved src/dst name matching every network unconditionally.
const Any = "any"

// Rule matches traffic between named subnets/zones (or Any). Src/Dst are
// OR-lists: any name in Src combined with any name in Dst matches.
type Rule struct {
	Name     string
	Src      []string
	Dst      []string
	Proto    Proto
	SrcPorts []string // "80" or "1000-2000"; only meaningful for tcp/udp
	DstPorts []string // "80" or "1000-2000"; only meaningful for tcp/udp
	Action   Action
	Mirror   bool // at compile time, also match traffic in the reverse direction (Dst->Src)
}

// Policy is the full ordered rule set plus what happens when nothing
// matches.
type Policy struct {
	DefaultAction Action
	Rules         []Rule // priority order: first match wins, like iptables
}
