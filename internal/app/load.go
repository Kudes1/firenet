package app

import (
	"fmt"

	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/topology"
)

// ParseProject converts topology and subnets from a ProjectDoc without validating
// cross-references. Callers either validate explicitly (LoadProject) or
// diff against a previous state first (DeletionErrors).
func ParseProject(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topo, err := doc.Topology.ToTopology()
	if err != nil {
		return nil, fmt.Errorf("load topology: %w", err)
	}
	subnets, err := doc.Subnets.ToSubnets()
	if err != nil {
		return nil, fmt.Errorf("load subnets: %w", err)
	}
	topo.Subnets = subnets
	return topo, nil
}

// LoadProject parses topology and subnets from a ProjectDoc into one validated
// Topology. Cross-file invariants — every network subnet exists, no subnet
// belongs to two networks — are enforced here because the documents reference
// each other.
func LoadProject(doc projectdoc.ProjectDoc) (*topology.Topology, error) {
	topo, err := ParseProject(doc)
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
