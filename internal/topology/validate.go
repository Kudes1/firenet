package topology

import (
	"fmt"
	"sort"
)

// Validate checks structural invariants: unique names, valid references, the
// one-role-per-interface rule, non-overlapping subnets, and acyclic zones.
func (t *Topology) Validate() error {
	if err := t.validateInterfaces(); err != nil {
		return err
	}
	if err := t.validateLinksAndAttachments(); err != nil {
		return err
	}
	if err := t.validateSubnets(); err != nil {
		return err
	}
	return t.validateZones()
}

func (t *Topology) validateInterfaces() error {
	for name, d := range t.Devices {
		seen := make(map[string]struct{}, len(d.Interfaces))
		for _, iface := range d.Interfaces {
			if _, ok := seen[iface]; ok {
				return fmt.Errorf("device %q: duplicate interface %q", name, iface)
			}
			seen[iface] = struct{}{}
		}
	}
	return nil
}

func (t *Topology) hasInterface(ref InterfaceRef) bool {
	d, ok := t.Devices[ref.Device]
	if !ok {
		return false
	}
	for _, iface := range d.Interfaces {
		if iface == ref.Interface {
			return true
		}
	}
	return false
}

// validateLinksAndAttachments enforces that every (device, interface) is
// used at most once across all links and subnet attachments combined, which
// keeps "what is physically wired to this port" unambiguous.
func (t *Topology) validateLinksAndAttachments() error {
	used := make(map[InterfaceRef]string)
	claim := func(ref InterfaceRef, where string) error {
		if !t.hasInterface(ref) {
			return fmt.Errorf("%s: unknown interface %s.%s", where, ref.Device, ref.Interface)
		}
		if prev, ok := used[ref]; ok {
			return fmt.Errorf("%s: interface %s.%s already used by %s", where, ref.Device, ref.Interface, prev)
		}
		used[ref] = where
		return nil
	}

	for i, l := range t.Links {
		where := fmt.Sprintf("link[%d]", i)
		if l.A.Device == l.B.Device {
			return fmt.Errorf("%s: both ends on the same device %q", where, l.A.Device)
		}
		if err := claim(l.A, where); err != nil {
			return err
		}
		if err := claim(l.B, where); err != nil {
			return err
		}
	}

	names := sortedSubnetNames(t.Subnets)
	for _, name := range names {
		where := fmt.Sprintf("subnet %q", name)
		for _, ref := range t.Subnets[name].AttachedTo {
			if err := claim(ref, where); err != nil {
				return err
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
