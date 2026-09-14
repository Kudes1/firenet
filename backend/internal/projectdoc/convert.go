package projectdoc

import (
	"fmt"
	"net/netip"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// ToTopology converts the wire doc to the domain model. It enforces the
// same per-entity invariants as the former topology.Load: known device
// kinds, unique names, host-only set addresses.
func (d TopologyDoc) ToTopology() (*topology.Topology, error) {
	topo := &topology.Topology{
		Devices:  make(map[string]topology.Device, len(d.Devices)),
		Networks: make(map[string]topology.Network, len(d.Networks)),
		Sets:     make(map[string]topology.Set, len(d.Sets)),
		Unions:   make(map[string]topology.Union, len(d.Unions)),
	}

	for _, dev := range d.Devices {
		kind := topology.DeviceKind(dev.Kind)
		if kind != topology.DeviceRouter && kind != topology.DeviceSwitch {
			return nil, fmt.Errorf("device %q: invalid kind %q (want %q or %q)", dev.Name, dev.Kind, topology.DeviceRouter, topology.DeviceSwitch)
		}
		if _, exists := topo.Devices[dev.Name]; exists {
			return nil, fmt.Errorf("duplicate device name %q", dev.Name)
		}
		topo.Devices[dev.Name] = topology.Device{Name: dev.Name, Kind: kind, Description: dev.Description}
	}

	for _, l := range d.Links {
		link := topology.Link{A: topology.Endpoint{Device: l.A.Device}, B: topology.Endpoint{Device: l.B.Device}}
		if l.Filter != nil {
			link.Filter = &topology.LinkFilter{AExports: l.Filter.AExports, BExports: l.Filter.BExports}
		}
		topo.Links = append(topo.Links, link)
	}

	for _, n := range d.Networks {
		if _, exists := topo.Networks[n.Name]; exists {
			return nil, fmt.Errorf("duplicate network name %q", n.Name)
		}
		attach := make([]topology.Endpoint, 0, len(n.Attach))
		for _, a := range n.Attach {
			attach = append(attach, topology.Endpoint{Device: a.Device})
		}
		topo.Networks[n.Name] = topology.Network{Name: n.Name, Subnets: n.Subnets, Attach: attach, Description: n.Description}
	}

	for _, s := range d.Sets {
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
		topo.Sets[s.Name] = topology.Set{Name: s.Name, Subnets: s.Subnets, Addresses: addresses, Description: s.Description}
	}

	for _, u := range d.Unions {
		if _, exists := topo.Unions[u.Name]; exists {
			return nil, fmt.Errorf("duplicate union name %q", u.Name)
		}
		topo.Unions[u.Name] = topology.Union{Name: u.Name, Devices: u.Devices, Networks: u.Networks, Description: u.Description}
	}

	return topo, nil
}

// ToSubnets converts the wire doc to the domain model: named CIDR blocks.
func (d SubnetsDoc) ToSubnets() (map[string]topology.Subnet, error) {
	subnets := make(map[string]topology.Subnet, len(d.Subnets))
	for _, s := range d.Subnets {
		if _, exists := subnets[s.Name]; exists {
			return nil, fmt.Errorf("duplicate subnet name %q", s.Name)
		}
		prefix, err := netip.ParsePrefix(s.CIDR)
		if err != nil {
			return nil, fmt.Errorf("subnet %q: invalid cidr %q: %w", s.Name, s.CIDR, err)
		}
		subnets[s.Name] = topology.Subnet{Name: s.Name, CIDR: prefix, Description: s.Description}
	}
	return subnets, nil
}

// ToRules converts the wire doc to the domain policy model.
func (d ProjectDoc) ToRules() *rules.Policy {
	pol := d.Rules.ToPolicy()
	return &pol
}

// parseHostPrefix accepts a bare IP or a host prefix and normalizes it to
// its full-length form (/32 for IPv4, /128 for IPv6).
func parseHostPrefix(s string) (netip.Prefix, error) {
	if i := indexByte(s, '/'); i >= 0 {
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

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
