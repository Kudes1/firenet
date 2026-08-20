// Package topology models the physical network: devices, links between
// them, and the subnets attached to them. It knows nothing about filtering
// policy.
package topology

import "net/netip"

// DeviceKind distinguishes managed routers (where firenet places
// iptables/ipset rules) from switches, which exist only for connectivity.
type DeviceKind string

const (
	DeviceRouter DeviceKind = "router"
	DeviceSwitch DeviceKind = "switch"
)

// Device is a network node with a fixed set of named interfaces.
type Device struct {
	Name       string
	Kind       DeviceKind
	Interfaces []string
}

// InterfaceRef identifies one named interface on one device.
type InterfaceRef struct {
	Device    string
	Interface string
}

// Link is a physical point-to-point connection between two interfaces.
type Link struct {
	A, B InterfaceRef
}

// Subnet is a named CIDR block, attached to one or more device interfaces
// (more than one for HA gateways, or a switch interface for hosts wired
// directly to a shared segment).
type Subnet struct {
	Name       string
	CIDR       netip.Prefix
	AttachedTo []InterfaceRef
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
