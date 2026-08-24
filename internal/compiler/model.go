// Package compiler places policy rules onto concrete devices: it resolves
// zones to subnets, finds which routers a src/dst subnet pair can transit,
// and produces one ipset+rule set per device.
package compiler

import "github.com/kudes1/firenet/internal/rules"

// IPSet is one named address set to be created on a device.
type IPSet struct {
	Name        string // generated, ipset-safe name (<=31 chars)
	DisplayName string // the original subnet/zone name, for traceability
	CIDRs       []string
}

// CompiledRule is one iptables rule, matching by ipset membership rather
// than by interface, so it holds regardless of which physical link a packet
// actually took.
type CompiledRule struct {
	Comment  string // source rule name, for traceability
	SrcSet   string // ipset name; "" = unconditional (any)
	DstSet   string
	SrcAddr  string // literal address/CIDR match (-s), when no ipset is used
	DstAddr  string // literal address/CIDR match (-d), when no ipset is used
	Proto    rules.Proto
	SrcPorts []string
	DstPorts []string
	Action   rules.Action
	JumpTo   string // target chain when Action == ActionJump
	Chain    string // owning chain name on this device
}

// CompiledChain is metadata of one chain present on a device.
type CompiledChain struct {
	Name     string
	Primary  bool                // the chain jumped into from FORWARD
	Position rules.ChainPosition // meaningful only when Primary
	Default  rules.Action
}

// DeviceRuleset is everything one managed device needs: its ipsets, the
// chains it hosts (primary first), and its ordered rules grouped by chain.
type DeviceRuleset struct {
	Device string
	IPSets []IPSet
	Chains []CompiledChain
	Rules  []CompiledRule
}
