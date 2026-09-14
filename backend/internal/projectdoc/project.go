package projectdoc

// ProjectDoc bundles the four documents that make up a firenet project —
// the unit internal/pgstore reads/writes as a whole.
type ProjectDoc struct {
	Topology TopologyDoc `json:"topology"`
	Subnets  SubnetsDoc  `json:"subnets"`
	Rules    PolicyDoc   `json:"rules"`
	Layout   LayoutDoc   `json:"layout"`
}
