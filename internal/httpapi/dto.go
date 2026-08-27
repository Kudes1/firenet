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
)

// NewPolicyDoc converts the domain model to the wire doc.
var NewPolicyDoc = projectdoc.NewPolicyDoc
