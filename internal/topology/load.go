package topology

import (
	"fmt"
	"io"
	"net/netip"

	"gopkg.in/yaml.v3"
)

type yamlEndpoint struct {
	Device    string `yaml:"device"`
	Interface string `yaml:"interface,omitempty"`
}

type yamlLink struct {
	A yamlEndpoint `yaml:"a"`
	B yamlEndpoint `yaml:"b"`
}

type yamlDevice struct {
	Name string `yaml:"name"`
	Kind string `yaml:"kind"`
}

type yamlNetwork struct {
	Name    string         `yaml:"name"`
	Subnets []string       `yaml:"subnets"`
	Attach  []yamlEndpoint `yaml:"attach"`
}

type yamlTopology struct {
	Devices  []yamlDevice  `yaml:"devices"`
	Links    []yamlLink    `yaml:"links"`
	Networks []yamlNetwork `yaml:"networks"`
}

type yamlSubnetDoc struct {
	Subnets []yamlSubnet `yaml:"subnets"`
}

type yamlSubnet struct {
	Name string `yaml:"name"`
	CIDR string `yaml:"cidr"`
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
		topo.Links = append(topo.Links, Link{
			A: Endpoint{Device: l.A.Device, Interface: l.A.Interface},
			B: Endpoint{Device: l.B.Device, Interface: l.B.Interface},
		})
	}

	for _, n := range raw.Networks {
		if _, exists := topo.Networks[n.Name]; exists {
			return nil, fmt.Errorf("duplicate network name %q", n.Name)
		}
		attach := make([]Endpoint, 0, len(n.Attach))
		for _, a := range n.Attach {
			attach = append(attach, Endpoint{Device: a.Device, Interface: a.Interface})
		}
		topo.Networks[n.Name] = Network{Name: n.Name, Subnets: n.Subnets, Attach: attach}
	}

	return topo, nil
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
		subnets[s.Name] = Subnet{Name: s.Name, CIDR: prefix}
	}
	return subnets, nil
}
