// Package projectdoc holds the wire-format types for a firenet project
// (topology, subnets, rules, layout) shared between internal/httpapi (the
// HTTP/JSON boundary) and internal/pgstore (entity-level persistence) —
// neither package may import the other, so these types live below both.
package projectdoc

// EndpointDoc is one side of a logical connection.
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

// EntityDoc is one export candidate for a link filter combo: a network or
// bare subnet, with its CIDR filled in for subnets.
type EntityDoc struct {
	Name string `json:"name"`
	CIDR string `json:"cidr,omitempty"`
}
