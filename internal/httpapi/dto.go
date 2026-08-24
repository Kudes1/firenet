// Package httpapi serves firenet's web UI and the JSON API it talks to. It
// is an adapter, at the same tier as internal/cli: it reuses
// internal/topology, internal/rules and internal/app for all domain logic
// and knows nothing about the CLI.
package httpapi

import "github.com/kudes1/firenet/internal/rules"

// EndpointDoc is one side of a logical connection. The Doc types in
// this file mirror the private YAML wire structs in
// internal/topology/load.go and internal/rules/load.go field-for-field, but
// exported and tagged for both YAML (the file format) and JSON (the
// browser) — the same value round-trips through either encoding, so no
// separate mapping layer is needed between the two.
type EndpointDoc struct {
	Device string `json:"device" yaml:"device"`
}

// LinkFilterDoc mirrors topology.LinkFilter on the wire. Export lists
// always serialize (no omitempty): an empty list means "announces
// nothing" and must survive round-trips.
type LinkFilterDoc struct {
	AExports []string `json:"aExports" yaml:"a-exports"`
	BExports []string `json:"bExports" yaml:"b-exports"`
}

// LinkDoc is a logical connection between two devices.
type LinkDoc struct {
	A      EndpointDoc    `json:"a" yaml:"a"`
	B      EndpointDoc    `json:"b" yaml:"b"`
	Filter *LinkFilterDoc `json:"filter,omitempty" yaml:"filter,omitempty"`
}

// DeviceDoc is a network node.
type DeviceDoc struct {
	Name string `json:"name" yaml:"name"`
	Kind string `json:"kind" yaml:"kind"`
}

// SubnetDoc is a named CIDR block. Attachment lives on the Network that
// contains it.
type SubnetDoc struct {
	Name        string `json:"name" yaml:"name"`
	CIDR        string `json:"cidr" yaml:"cidr"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`
}

// SubnetsDoc is the full wire shape of subnets.yaml.
type SubnetsDoc struct {
	Subnets []SubnetDoc `json:"subnets" yaml:"subnets"`
}

// NetworkDoc is one L2 segment: an attachment to devices plus the named
// list of member subnets (which becomes one ipset at compile time).
type NetworkDoc struct {
	Name        string        `json:"name" yaml:"name"`
	Subnets     []string      `json:"subnets,omitempty" yaml:"subnets,omitempty"`
	Attach      []EndpointDoc `json:"attach,omitempty" yaml:"attach,omitempty"`
	Description string        `json:"description,omitempty" yaml:"description,omitempty"`
}

// SetDoc is a named address group for rule matching: references to subnets
// plus individual host addresses.
type SetDoc struct {
	Name        string   `json:"name" yaml:"name"`
	Subnets     []string `json:"subnets,omitempty" yaml:"subnets,omitempty"`
	Addresses   []string `json:"addresses,omitempty" yaml:"addresses,omitempty"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}

// UnionDoc is a visual location grouping devices and networks. Purely
// presentational: it never reaches the compiler.
type UnionDoc struct {
	Name        string   `json:"name" yaml:"name"`
	Devices     []string `json:"devices,omitempty" yaml:"devices,omitempty"`
	Networks    []string `json:"networks,omitempty" yaml:"networks,omitempty"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
}

// TopologyDoc is the full wire shape of topology.yaml.
type TopologyDoc struct {
	Devices  []DeviceDoc  `json:"devices" yaml:"devices"`
	Links    []LinkDoc    `json:"links" yaml:"links"`
	Networks []NetworkDoc `json:"networks" yaml:"networks"`
	Sets     []SetDoc     `json:"sets" yaml:"sets"`
	Unions   []UnionDoc   `json:"unions" yaml:"unions"`
}

// RuleDoc matches traffic between named subnets/zones (or "any").
type RuleDoc struct {
	Name     string   `json:"name" yaml:"name"`
	Comment  string   `json:"comment,omitempty" yaml:"comment,omitempty"`
	Src      []string `json:"src" yaml:"src"`
	Dst      []string `json:"dst" yaml:"dst"`
	Proto    string   `json:"proto,omitempty" yaml:"proto,omitempty"`
	SrcPorts []string `json:"srcPorts,omitempty" yaml:"srcPorts,omitempty"`
	DstPorts []string `json:"dstPorts,omitempty" yaml:"dstPorts,omitempty"`
	Action   string   `json:"action" yaml:"action"`
	JumpTo   string   `json:"jumpTo,omitempty" yaml:"jumpTo,omitempty"`
	Mirror   bool     `json:"mirror,omitempty" yaml:"mirror,omitempty"`
}

// ChainDoc is one named chain of the policy wire format. The first element
// of PolicyDoc.Chains is the primary chain (its jump lands in FORWARD).
type ChainDoc struct {
	Name          string    `json:"name" yaml:"name"`
	DefaultAction string    `json:"defaultAction" yaml:"defaultAction"`
	ChainPosition string    `json:"chainPosition,omitempty" yaml:"chainPosition,omitempty"`
	Rules         []RuleDoc `json:"rules" yaml:"rules"`
}

// PolicyDoc is the full wire shape of rules.yaml (chains format). Legacy
// flat files are read by rules.Load and normalized here, never stored back.
type PolicyDoc struct {
	Chains []ChainDoc `json:"chains" yaml:"chains"`
}

// ToPolicy converts the wire doc to the domain model.
func (d PolicyDoc) ToPolicy() rules.Policy {
	pol := rules.Policy{}
	for _, c := range d.Chains {
		ch := rules.Chain{
			Name:          c.Name,
			DefaultAction: rules.Action(c.DefaultAction),
			ChainPosition: rules.ChainPosition(c.ChainPosition),
		}
		for _, r := range c.Rules {
			ch.Rules = append(ch.Rules, rules.Rule{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: rules.Proto(r.Proto), SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: rules.Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		pol.Chains = append(pol.Chains, ch)
	}
	return pol
}

// NewPolicyDoc converts the domain model to the wire doc.
func NewPolicyDoc(pol *rules.Policy) PolicyDoc {
	doc := PolicyDoc{}
	for _, c := range pol.Chains {
		ch := ChainDoc{
			Name:          c.Name,
			DefaultAction: string(c.DefaultAction),
			ChainPosition: string(c.ChainPosition),
			Rules:         []RuleDoc{},
		}
		for _, r := range c.Rules {
			ch.Rules = append(ch.Rules, RuleDoc{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: string(r.Proto), SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: string(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		doc.Chains = append(doc.Chains, ch)
	}
	return doc
}
