package app

import (
	"bytes"
	"fmt"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/topology"
)

// LoadProject merges a topology.yaml document (devices, links, networks)
// with a subnets.yaml document (named CIDR blocks) into one validated
// Topology. Cross-file invariants — every network subnet exists, no subnet
// belongs to two networks — are enforced here because the files reference
// each other.
func LoadProject(topologyYAML, subnetsYAML []byte) (*topology.Topology, error) {
	topo, err := ParseProject(topologyYAML, subnetsYAML)
	if err != nil {
		return nil, err
	}
	if err := topo.Validate(); err != nil {
		return nil, fmt.Errorf("invalid project: %w", err)
	}
	// Filtered-link exports must name entities the side can reach without
	// that link; otherwise the filter silently announces nothing.
	if err := graph.ValidateFilterExports(topo); err != nil {
		return nil, fmt.Errorf("invalid project: %w", err)
	}
	return topo, nil
}

// ParseProject merges topology and subnets YAML without validating
// cross-references. Callers either validate explicitly (LoadProject) or
// diff against a previous state first (DeletionErrors).
func ParseProject(topologyYAML, subnetsYAML []byte) (*topology.Topology, error) {
	topo, err := topology.Load(bytes.NewReader(topologyYAML))
	if err != nil {
		return nil, fmt.Errorf("load topology: %w", err)
	}
	subnets, err := topology.LoadSubnets(bytes.NewReader(subnetsYAML))
	if err != nil {
		return nil, fmt.Errorf("load subnets: %w", err)
	}
	topo.Subnets = subnets
	return topo, nil
}
