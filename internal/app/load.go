package app

import (
	"bytes"
	"fmt"

	"github.com/kudes1/firenet/internal/topology"
)

// LoadProject merges a topology.yaml document (devices, links, networks)
// with a subnets.yaml document (named CIDR blocks) into one validated
// Topology. Cross-file invariants — every network subnet exists, no subnet
// belongs to two networks — are enforced here because the files reference
// each other.
func LoadProject(topologyYAML, subnetsYAML []byte) (*topology.Topology, error) {
	topo, err := topology.Load(bytes.NewReader(topologyYAML))
	if err != nil {
		return nil, fmt.Errorf("load topology: %w", err)
	}
	subnets, err := topology.LoadSubnets(bytes.NewReader(subnetsYAML))
	if err != nil {
		return nil, fmt.Errorf("load subnets: %w", err)
	}
	topo.Subnets = subnets
	if err := topo.Validate(); err != nil {
		return nil, fmt.Errorf("invalid project: %w", err)
	}
	return topo, nil
}
