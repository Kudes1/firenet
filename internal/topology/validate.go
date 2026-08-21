package topology

import (
	"fmt"
	"sort"
)

// Validate checks structural invariants: unique names, valid references,
// non-overlapping subnets, and each subnet in at most one network.
func (t *Topology) Validate() error {
	if err := t.validateLinks(); err != nil {
		return err
	}
	if err := t.validateSubnets(); err != nil {
		return err
	}
	return t.validateNetworks()
}

// validateLinks checks that every link and network attachment references a
// known device, and that no link connects a device to itself.
func (t *Topology) validateLinks() error {
	for i, l := range t.Links {
		where := fmt.Sprintf("link[%d]", i)
		if _, ok := t.Devices[l.A.Device]; !ok {
			return fmt.Errorf("%s: unknown device %q", where, l.A.Device)
		}
		if _, ok := t.Devices[l.B.Device]; !ok {
			return fmt.Errorf("%s: unknown device %q", where, l.B.Device)
		}
		if l.A.Device == l.B.Device {
			return fmt.Errorf("%s: both ends on the same device %q", where, l.A.Device)
		}
	}

	for _, name := range sortedNetworkNames(t.Networks) {
		n := t.Networks[name]
		for _, ref := range n.Attach {
			if _, ok := t.Devices[ref.Device]; !ok {
				return fmt.Errorf("network %q: unknown device %q", name, ref.Device)
			}
		}
	}
	return nil
}

func (t *Topology) validateSubnets() error {
	names := sortedSubnetNames(t.Subnets)
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			a, b := t.Subnets[names[i]], t.Subnets[names[j]]
			if a.CIDR.Overlaps(b.CIDR) {
				return fmt.Errorf("subnet %q (%s) overlaps subnet %q (%s)", a.Name, a.CIDR, b.Name, b.CIDR)
			}
		}
	}
	return nil
}

func (t *Topology) validateNetworks() error {
	owner := make(map[string]string, len(t.Subnets)) // subnet name -> network name
	for _, name := range sortedNetworkNames(t.Networks) {
		for _, s := range t.Networks[name].Subnets {
			if _, ok := t.Subnets[s]; !ok {
				return fmt.Errorf("network %q: unknown subnet %q", name, s)
			}
			if prev, ok := owner[s]; ok {
				return fmt.Errorf("subnet %q belongs to both network %q and %q", s, prev, name)
			}
			owner[s] = name
		}
	}
	return nil
}

// ResolveNetwork flattens a subnet or network name into its constituent
// subnet names (a bare subnet name resolves to itself).
func (t *Topology) ResolveNetwork(name string) ([]string, error) {
	if _, ok := t.Subnets[name]; ok {
		return []string{name}, nil
	}
	n, ok := t.Networks[name]
	if !ok {
		return nil, fmt.Errorf("unknown network or subnet %q", name)
	}
	out := append([]string(nil), n.Subnets...)
	sort.Strings(out)
	return out, nil
}

func sortedNetworkNames(m map[string]Network) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sortedSubnetNames(m map[string]Subnet) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
