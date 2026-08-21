package topology

import (
	"fmt"
	"sort"
)

// Validate checks structural invariants: unique names, valid references,
// non-overlapping subnets, and acyclic zones.
func (t *Topology) Validate() error {
	if err := t.validateLinks(); err != nil {
		return err
	}
	if err := t.validateSubnets(); err != nil {
		return err
	}
	return t.validateZones()
}

// validateLinks checks that every link and subnet attachment references a
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

	for _, name := range sortedSubnetNames(t.Subnets) {
		where := fmt.Sprintf("subnet %q", name)
		for _, ref := range t.Subnets[name].AttachedTo {
			if _, ok := t.Devices[ref.Device]; !ok {
				return fmt.Errorf("%s: unknown device %q", where, ref.Device)
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

func (t *Topology) validateZones() error {
	for name, z := range t.Zones {
		for _, s := range z.Subnets {
			if _, ok := t.Subnets[s]; !ok {
				return fmt.Errorf("zone %q: unknown subnet %q", name, s)
			}
		}
		for _, zz := range z.Zones {
			if _, ok := t.Zones[zz]; !ok {
				return fmt.Errorf("zone %q: unknown nested zone %q", name, zz)
			}
		}
	}
	for name := range t.Zones {
		if _, err := t.ResolveZone(name); err != nil {
			return err
		}
	}
	return nil
}

// ResolveZone flattens a subnet or zone name into its constituent subnet
// names (a bare subnet name resolves to itself). Nested zones are unioned;
// cycles are reported as errors.
func (t *Topology) ResolveZone(name string) ([]string, error) {
	visiting := make(map[string]bool)
	return t.resolve(name, visiting)
}

func (t *Topology) resolve(name string, visiting map[string]bool) ([]string, error) {
	if s, ok := t.Subnets[name]; ok {
		return []string{s.Name}, nil
	}
	z, ok := t.Zones[name]
	if !ok {
		return nil, fmt.Errorf("unknown zone or subnet %q", name)
	}
	if visiting[name] {
		return nil, fmt.Errorf("cycle detected in zone %q", name)
	}
	visiting[name] = true
	defer delete(visiting, name)

	seen := make(map[string]struct{})
	var out []string
	add := func(s string) {
		if _, ok := seen[s]; !ok {
			seen[s] = struct{}{}
			out = append(out, s)
		}
	}
	for _, s := range z.Subnets {
		add(s)
	}
	for _, zz := range z.Zones {
		sub, err := t.resolve(zz, visiting)
		if err != nil {
			return nil, err
		}
		for _, s := range sub {
			add(s)
		}
	}
	sort.Strings(out)
	return out, nil
}

func sortedSubnetNames(m map[string]Subnet) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
