// Package topology models the logical network: devices, the connections
// between them, subnets, and networks (named subnet groups) attached to
// them. It knows nothing about filtering policy.
package topology

import "net/netip"

// DeviceKind distinguishes managed routers (where firenet places
// iptables/ipset rules) from switches, which exist only for connectivity.
type DeviceKind string

const (
	DeviceRouter DeviceKind = "router"
	DeviceSwitch DeviceKind = "switch"
)

// Device is a network node.
type Device struct {
	Name        string
	Kind        DeviceKind
	Description string // optional note
}

// Endpoint is one side of a logical connection.
type Endpoint struct {
	Device string
}

// LinkFilter restricts which entities each side exports across the link
// (route-filter semantics): traffic from subnet S to subnet D may cross
// in direction A→B only if S resolves from AExports and D from BExports.
type LinkFilter struct {
	AExports []string // networks/subnets side A announces
	BExports []string // networks/subnets side B announces
}

// Link is a logical connection between two devices. At most one link may
// connect the same pair of devices.
type Link struct {
	A, B   Endpoint
	Filter *LinkFilter // nil = обычная связь полной связности
}

// Subnet is a named CIDR block. It carries no attachment of its own: where
// it lives on the wire is defined by the Network that contains it.
type Subnet struct {
	Name        string
	CIDR        netip.Prefix
	Description string // optional note
}

// Network is one L2 segment: an attachment to one or more devices plus the
// named list of member subnets (which becomes one ipset at compile time).
type Network struct {
	Name        string
	Subnets     []string
	Attach      []Endpoint
	Description string // optional note
}

// Set is a named address group for rule matching: references to subnets
// plus individual host addresses. Unlike Network it has no attachment —
// it only defines what an ipset contains.
type Set struct {
	Name        string
	Subnets     []string       // references to Subnet
	Addresses   []netip.Prefix // host prefixes (/32, /128)
	Description string         // optional note
}

// Union is a visual grouping of devices and networks: one location.
// Purely presentational — it never affects compilation.
type Union struct {
	Name        string
	Devices     []string // refs to Device
	Networks    []string // refs to Network
	Description string   // optional note
}

// Topology is the full declared network: devices, their links, and the
// subnets/networks layered on top.
type Topology struct {
	Devices  map[string]Device
	Links    []Link
	Subnets  map[string]Subnet
	Networks map[string]Network
	Sets     map[string]Set
	Unions   map[string]Union
}
