// Package rules models the filtering policy: a priority-ordered list of
// rules matching traffic by named subnets/zones from internal/topology.
package rules

// Action is what a matching rule does with traffic.
type Action string

const (
	ActionAllow  Action = "allow"
	ActionDeny   Action = "deny"
	ActionReturn Action = "return"
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

// ChainPosition controls where firenet's jump into its own chain is placed
// relative to whatever else already lives in FORWARD.
type ChainPosition string

const (
	// ChainTop puts firenet's rules ahead of anything else in FORWARD.
	ChainTop ChainPosition = "top"
	// ChainBottom makes firenet's rules a fallback, evaluated only after
	// whatever the device administrator manages directly in FORWARD.
	ChainBottom ChainPosition = "bottom"
)

// DefaultChainName is used when a policy doesn't set ChainName.
const DefaultChainName = "FIRENET-FWD"

// Rule matches traffic between named subnets/zones (or Any). Src/Dst are
// OR-lists: any name in Src combined with any name in Dst matches.
type Rule struct {
	Name     string
	Comment  string // free-form description rendered into iptables --comment; falls back to Name
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
	ChainName     string        // iptables chain firenet owns; "" defaults to DefaultChainName
	ChainPosition ChainPosition // where the jump into ChainName is placed in FORWARD
	Rules         []Rule        // priority order: first match wins, like iptables
}
