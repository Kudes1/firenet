package topology

import (
	"fmt"
	"io"
	"net/netip"

	"gopkg.in/yaml.v3"
)

type yamlInterfaceRef struct {
	Device    string `yaml:"device"`
	Interface string `yaml:"interface"`
}

type yamlLink struct {
	A yamlInterfaceRef `yaml:"a"`
	B yamlInterfaceRef `yaml:"b"`
}

type yamlDevice struct {
	Name       string   `yaml:"name"`
	Kind       string   `yaml:"kind"`
	Interfaces []string `yaml:"interfaces"`
}

type yamlSubnet struct {
	Name   string             `yaml:"name"`
	CIDR   string             `yaml:"cidr"`
	Attach []yamlInterfaceRef `yaml:"attach"`
}

type yamlZone struct {
	Name    string   `yaml:"name"`
	Subnets []string `yaml:"subnets"`
	Zones   []string `yaml:"zones"`
}

type yamlTopology struct {
	Devices []yamlDevice `yaml:"devices"`
	Links   []yamlLink   `yaml:"links"`
	Subnets []yamlSubnet `yaml:"subnets"`
	Zones   []yamlZone   `yaml:"zones"`
}

// Load decodes a topology.yaml document. It does not call Validate.
func Load(r io.Reader) (*Topology, error) {
	dec := yaml.NewDecoder(r)
	dec.KnownFields(true)
	var raw yamlTopology
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode topology yaml: %w", err)
	}

	topo := &Topology{
		Devices: make(map[string]Device, len(raw.Devices)),
		Subnets: make(map[string]Subnet, len(raw.Subnets)),
		Zones:   make(map[string]Zone, len(raw.Zones)),
	}

	for _, d := range raw.Devices {
		kind := DeviceKind(d.Kind)
		if kind != DeviceRouter && kind != DeviceSwitch {
			return nil, fmt.Errorf("device %q: invalid kind %q (want %q or %q)", d.Name, d.Kind, DeviceRouter, DeviceSwitch)
		}
		if _, exists := topo.Devices[d.Name]; exists {
			return nil, fmt.Errorf("duplicate device name %q", d.Name)
		}
		topo.Devices[d.Name] = Device{Name: d.Name, Kind: kind, Interfaces: d.Interfaces}
	}

	for _, l := range raw.Links {
		topo.Links = append(topo.Links, Link{
			A: InterfaceRef{Device: l.A.Device, Interface: l.A.Interface},
			B: InterfaceRef{Device: l.B.Device, Interface: l.B.Interface},
		})
	}

	for _, s := range raw.Subnets {
		prefix, err := netip.ParsePrefix(s.CIDR)
		if err != nil {
			return nil, fmt.Errorf("subnet %q: invalid cidr %q: %w", s.Name, s.CIDR, err)
		}
		if _, exists := topo.Subnets[s.Name]; exists {
			return nil, fmt.Errorf("duplicate subnet name %q", s.Name)
		}
		attach := make([]InterfaceRef, 0, len(s.Attach))
		for _, a := range s.Attach {
			attach = append(attach, InterfaceRef{Device: a.Device, Interface: a.Interface})
		}
		topo.Subnets[s.Name] = Subnet{Name: s.Name, CIDR: prefix, AttachedTo: attach}
	}

	for _, z := range raw.Zones {
		if _, exists := topo.Zones[z.Name]; exists {
			return nil, fmt.Errorf("duplicate zone name %q", z.Name)
		}
		topo.Zones[z.Name] = Zone{Name: z.Name, Subnets: z.Subnets, Zones: z.Zones}
	}

	return topo, nil
}
