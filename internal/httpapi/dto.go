// Package httpapi serves firenet's web UI and the JSON API it talks to. It
// is an adapter, at the same tier as internal/cli: it reuses
// internal/topology, internal/rules and internal/app for all domain logic
// and knows nothing about the CLI.
package httpapi

// EndpointDoc is one side of a logical connection: a device, with an
// optional interface label kept purely for documentation. The Doc types in
// this file mirror the private YAML wire structs in
// internal/topology/load.go and internal/rules/load.go field-for-field, but
// exported and tagged for both YAML (the file format) and JSON (the
// browser) — the same value round-trips through either encoding, so no
// separate mapping layer is needed between the two.
type EndpointDoc struct {
	Device    string `json:"device" yaml:"device"`
	Interface string `json:"interface,omitempty" yaml:"interface,omitempty"`
}

// LinkDoc is a logical connection between two devices.
type LinkDoc struct {
	A EndpointDoc `json:"a" yaml:"a"`
	B EndpointDoc `json:"b" yaml:"b"`
}

// DeviceDoc is a network node.
type DeviceDoc struct {
	Name string `json:"name" yaml:"name"`
	Kind string `json:"kind" yaml:"kind"`
}

// SubnetDoc is a named CIDR block. Attachment lives on the Network that
// contains it.
type SubnetDoc struct {
	Name string `json:"name" yaml:"name"`
	CIDR string `json:"cidr" yaml:"cidr"`
}

// SubnetsDoc is the full wire shape of subnets.yaml.
type SubnetsDoc struct {
	Subnets []SubnetDoc `json:"subnets" yaml:"subnets"`
}

// NetworkDoc is one L2 segment: an attachment to devices plus the named
// list of member subnets (which becomes one ipset at compile time).
type NetworkDoc struct {
	Name    string        `json:"name" yaml:"name"`
	Subnets []string      `json:"subnets,omitempty" yaml:"subnets,omitempty"`
	Attach  []EndpointDoc `json:"attach,omitempty" yaml:"attach,omitempty"`
}

// TopologyDoc is the full wire shape of topology.yaml.
type TopologyDoc struct {
	Devices  []DeviceDoc  `json:"devices" yaml:"devices"`
	Links    []LinkDoc    `json:"links" yaml:"links"`
	Networks []NetworkDoc `json:"networks" yaml:"networks"`
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
	Mirror   bool     `json:"mirror,omitempty" yaml:"mirror,omitempty"`
}

// PolicyDoc is the full wire shape of rules.yaml.
type PolicyDoc struct {
	DefaultAction string    `json:"defaultAction" yaml:"defaultAction"`
	ChainName     string    `json:"chainName,omitempty" yaml:"chainName,omitempty"`
	ChainPosition string    `json:"chainPosition,omitempty" yaml:"chainPosition,omitempty"`
	Rules         []RuleDoc `json:"rules" yaml:"rules"`
}
