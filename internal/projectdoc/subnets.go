package projectdoc

// SubnetDoc is a named CIDR block. Attachment lives on the Network that
// contains it.
type SubnetDoc struct {
	Name        string `json:"name" yaml:"name"`
	CIDR        string `json:"cidr" yaml:"cidr"`
	Description string `json:"description,omitempty" yaml:"description,omitempty"`
}

// SubnetsDoc is the full wire shape of subnets.yaml.
type SubnetsDoc struct {
	Subnets []SubnetDoc `json:"subnets" yaml:"subnets"`
}
