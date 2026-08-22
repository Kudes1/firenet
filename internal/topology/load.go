package topology

import (
	"fmt"
	"io"
	"net/netip"
	"strings"

	"gopkg.in/yaml.v3"
)

type yamlEndpoint struct {
	Device string `yaml:"device"`
}

type yamlLinkFilter struct {
	AExports []string `yaml:"a-exports"`
	BExports []string `yaml:"b-exports"`
}

type yamlLink struct {
	A      yamlEndpoint    `yaml:"a"`
	B      yamlEndpoint    `yaml:"b"`
	Filter *yamlLinkFilter `yaml:"filter,omitempty"`
}

type yamlDevice struct {
	Name string `yaml:"name"`
	Kind string `yaml:"kind"`
}

type yamlNetwork struct {
	Name        string         `yaml:"name"`
	Subnets     []string       `yaml:"subnets"`
	Attach      []yamlEndpoint `yaml:"attach"`
	Description string         `yaml:"description,omitempty"`
}

type yamlSet struct {
	Name        string   `yaml:"name"`
	Subnets     []string `yaml:"subnets,omitempty"`
	Addresses   []string `yaml:"addresses,omitempty"`
	Description string   `yaml:"description,omitempty"`
}

type yamlUnion struct {
	Name        string   `yaml:"name"`
	Devices     []string `yaml:"devices,omitempty"`
	Networks    []string `yaml:"networks,omitempty"`
	Description string   `yaml:"description,omitempty"`
}

type yamlTopology struct {
	Devices  []yamlDevice  `yaml:"devices"`
	Links    []yamlLink    `yaml:"links"`
	Networks []yamlNetwork `yaml:"networks"`
	Sets     []yamlSet     `yaml:"sets"`
	Unions   []yamlUnion   `yaml:"unions"`
}

type yamlSubnetDoc struct {
	Subnets []yamlSubnet `yaml:"subnets"`
}

type yamlSubnet struct {
	Name        string `yaml:"name"`
	CIDR        string `yaml:"cidr"`
	Description string `yaml:"description,omitempty"`
}

// Load decodes a topology.yaml document (devices, links, networks).
// It does not call Validate.
func Load(r io.Reader) (*Topology, error) {
	dec := yaml.NewDecoder(r)
	dec.KnownFields(true)
	var raw yamlTopology
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode topology yaml: %w", err)
	}

	topo := &Topology{
		Devices:  make(map[string]Device, len(raw.Devices)),
		Networks: make(map[string]Network, len(raw.Networks)),
		Sets:     make(map[string]Set, len(raw.Sets)),
		Unions:   make(map[string]Union, len(raw.Unions)),
	}

	for _, d := range raw.Devices {
		kind := DeviceKind(d.Kind)
		if kind != DeviceRouter && kind != DeviceSwitch {
			return nil, fmt.Errorf("device %q: invalid kind %q (want %q or %q)", d.Name, d.Kind, DeviceRouter, DeviceSwitch)
		}
		if _, exists := topo.Devices[d.Name]; exists {
			return nil, fmt.Errorf("duplicate device name %q", d.Name)
		}
		topo.Devices[d.Name] = Device{Name: d.Name, Kind: kind}
	}

	for _, l := range raw.Links {
		link := Link{A: Endpoint{Device: l.A.Device}, B: Endpoint{Device: l.B.Device}}
		if l.Filter != nil {
			link.Filter = &LinkFilter{AExports: l.Filter.AExports, BExports: l.Filter.BExports}
		}
		topo.Links = append(topo.Links, link)
	}

	for _, n := range raw.Networks {
		if _, exists := topo.Networks[n.Name]; exists {
			return nil, fmt.Errorf("duplicate network name %q", n.Name)
		}
		attach := make([]Endpoint, 0, len(n.Attach))
		for _, a := range n.Attach {
			attach = append(attach, Endpoint{Device: a.Device})
		}
		topo.Networks[n.Name] = Network{Name: n.Name, Subnets: n.Subnets, Attach: attach, Description: n.Description}
	}

	for _, s := range raw.Sets {
		if _, exists := topo.Sets[s.Name]; exists {
			return nil, fmt.Errorf("duplicate set name %q", s.Name)
		}
		addresses := make([]netip.Prefix, 0, len(s.Addresses))
		for _, a := range s.Addresses {
			prefix, err := parseHostPrefix(a)
			if err != nil {
				return nil, fmt.Errorf("set %q: %w", s.Name, err)
			}
			addresses = append(addresses, prefix)
		}
		topo.Sets[s.Name] = Set{Name: s.Name, Subnets: s.Subnets, Addresses: addresses, Description: s.Description}
	}

	for _, s := range raw.Unions {
		if _, exists := topo.Unions[s.Name]; exists {
			return nil, fmt.Errorf("duplicate union name %q", s.Name)
		}
		topo.Unions[s.Name] = Union{Name: s.Name, Devices: s.Devices, Networks: s.Networks, Description: s.Description}
	}

	return topo, nil
}

// parseHostPrefix accepts a bare IP or a host prefix and normalizes it to
// its full-length form (/32 for IPv4, /128 for IPv6).
func parseHostPrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		prefix, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("invalid address prefix %q: %w", s, err)
		}
		if bits := prefix.Addr().BitLen(); prefix.Bits() != bits {
			return netip.Prefix{}, fmt.Errorf("address %q must be a single host (/%d)", s, bits)
		}
		return prefix, nil
	}
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("invalid address %q: %w", s, err)
	}
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

// LoadSubnets decodes a subnets.yaml document. It does not call Validate.
func LoadSubnets(r io.Reader) (map[string]Subnet, error) {
	dec := yaml.NewDecoder(r)
	dec.KnownFields(true)
	var raw yamlSubnetDoc
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode subnets yaml: %w", err)
	}

	subnets := make(map[string]Subnet, len(raw.Subnets))
	for _, s := range raw.Subnets {
		prefix, err := netip.ParsePrefix(s.CIDR)
		if err != nil {
			return nil, fmt.Errorf("subnet %q: invalid cidr %q: %w", s.Name, s.CIDR, err)
		}
		if _, exists := subnets[s.Name]; exists {
			return nil, fmt.Errorf("duplicate subnet name %q", s.Name)
		}
		subnets[s.Name] = Subnet{Name: s.Name, CIDR: prefix, Description: s.Description}
	}
	return subnets, nil
}
