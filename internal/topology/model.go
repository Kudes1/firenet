// Package topology models the logical network: devices, the connections
// between them, and the subnets attached to them. It knows nothing about
// filtering policy.
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
	Name string
	Kind DeviceKind
}

// Endpoint is one side of a logical connection: a device, with an optional
// interface label kept purely for documentation — it has no bearing on
// validation, rule matching, or compiled output.
type Endpoint struct {
	Device    string
	Interface string // optional
}

// Link is a logical connection between two devices. Multiple links between
// the same pair of devices are allowed (e.g. redundant paths).
type Link struct {
	A, B Endpoint
}

// Subnet is a named CIDR block, attached to one or more devices (more than
// one for HA gateways, or a switch for hosts wired directly to a shared
// segment).
type Subnet struct {
	Name       string
	CIDR       netip.Prefix
	AttachedTo []Endpoint
}

// Zone groups subnets and/or other zones under one name for use in rules.
type Zone struct {
	Name    string
	Subnets []string
	Zones   []string
}

// Topology is the full declared network: devices, their links, and the
// subnets/zones layered on top.
type Topology struct {
	Devices map[string]Device
	Links   []Link
	Subnets map[string]Subnet
	Zones   map[string]Zone
}
