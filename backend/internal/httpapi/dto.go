// Package httpapi serves firenet's web UI and the JSON API it talks to. It
// is an adapter, at the same tier as internal/cli: it reuses
// internal/topology, internal/rules and internal/app for all domain logic
// and knows nothing about the CLI.
package httpapi

import "github.com/kudes1/firenet/internal/projectdoc"

// These are aliases, not new types: internal/projectdoc is the single
// source of truth (internal/pgstore needs the same types and can't import
// this package, since this package will import internal/pgstore). Every
// existing reference to httpapi.TopologyDoc etc. keeps compiling as-is.
type (
	EndpointDoc   = projectdoc.EndpointDoc
	LinkFilterDoc = projectdoc.LinkFilterDoc
	LinkDoc       = projectdoc.LinkDoc
	DeviceDoc     = projectdoc.DeviceDoc
	NetworkDoc    = projectdoc.NetworkDoc
	SetDoc        = projectdoc.SetDoc
	UnionDoc      = projectdoc.UnionDoc
	TopologyDoc   = projectdoc.TopologyDoc
	EntityDoc     = projectdoc.EntityDoc
	SubnetDoc     = projectdoc.SubnetDoc
	SubnetsDoc    = projectdoc.SubnetsDoc
	RuleDoc       = projectdoc.RuleDoc
	ChainDoc      = projectdoc.ChainDoc
	PolicyDoc     = projectdoc.PolicyDoc
	LayoutDoc     = projectdoc.LayoutDoc
	LayoutPoint   = projectdoc.LayoutPoint
	LayoutCamera  = projectdoc.LayoutCamera
)

// NewPolicyDoc converts the domain model to the wire doc.
var NewPolicyDoc = projectdoc.NewPolicyDoc

// topologyOperation is one draft-mutating command from the topology
// editor: Kind selects the command, and applyTopologyOperation reads only
// the fields that Kind names. It is the wire and in-process shape for
// both applyTopologyOperation (this package) and the POST
// .../topology/operations handler (added in a later change) that decodes
// it from JSON.
//
// Link, when present, always identifies its target link by endpoint pair
// (A/B device names) — never by array position — via linkIndex. For
// "create-link" it is the full link (Filter included, if set); for every
// other link command it is only an A/B pair used to locate the link, and
// Filter below carries the "set-link-filter" payload instead.
type topologyOperation struct {
	Kind string `json:"kind"`

	// Full payloads for the "create-*" commands and (Link only) for
	// locating an existing link by its endpoint pair.
	Device  *DeviceDoc     `json:"device,omitempty"`
	Network *NetworkDoc    `json:"network,omitempty"`
	Link    *LinkDoc       `json:"link,omitempty"`
	Union   *UnionDoc      `json:"union,omitempty"`
	Filter  *LinkFilterDoc `json:"filter,omitempty"`

	// Names identify the target of a delete/attach/detach/union-membership
	// command, independent of the create payloads above.
	DeviceName  string `json:"deviceName,omitempty"`
	NetworkName string `json:"networkName,omitempty"`
	UnionName   string `json:"unionName,omitempty"`

	// Attach is the device endpoint for "attach-network"/"detach-network".
	Attach *EndpointDoc `json:"attach,omitempty"`

	// Layout payload: exactly one of these is read, matching Kind.
	Position  *LayoutPoint    `json:"position,omitempty"`
	Waypoints [][]LayoutPoint `json:"waypoints,omitempty"`
	Camera    *LayoutCamera   `json:"camera,omitempty"`
}
