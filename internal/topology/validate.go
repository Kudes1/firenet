package topology

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"
)

// ParseEndpointPrefix parses a rule endpoint written literally as an IPv4
// address (becomes /32) or CIDR. It rejects names, garbage, and IPv6.
func ParseEndpointPrefix(s string) (netip.Prefix, bool) {
	if i := strings.IndexByte(s, '/'); i >= 0 {
		p, err := netip.ParsePrefix(s)
		if err != nil || !p.Addr().Is4() {
			return netip.Prefix{}, false
		}
		return p.Masked(), true
	}
	a, err := netip.ParseAddr(s)
	if err != nil || !a.Is4() {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(a, a.BitLen()), true
}

// Validate checks structural invariants: unique names, valid references,
// non-overlapping subnets, and each subnet in at most one network.
func (t *Topology) Validate() error {
	if err := t.validateLinks(); err != nil {
		return err
	}
	if err := t.validateSubnets(); err != nil {
		return err
	}
	if err := t.validateNetworks(); err != nil {
		return err
	}
	if err := t.validateSets(); err != nil {
		return err
	}
	return t.validateUnions()
}

// validateLinks checks that every link and network attachment references a
// known device, no link connects a device to itself, and each device pair is
// connected by at most one link.
func (t *Topology) validateLinks() error {
	seen := make(map[[2]string]int, len(t.Links))
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
		pair := [2]string{l.A.Device, l.B.Device}
		if pair[0] > pair[1] {
			pair[0], pair[1] = pair[1], pair[0]
		}
		if prev, dup := seen[pair]; dup {
			return fmt.Errorf("%s: duplicate link between %q and %q (already link[%d])", where, pair[0], pair[1], prev)
		}
		seen[pair] = i

		if l.Filter != nil {
			if t.Devices[l.A.Device].Kind != DeviceRouter || t.Devices[l.B.Device].Kind != DeviceRouter {
				return fmt.Errorf("%s: filtered link must connect two routers", where)
			}
			if l.Filter.AExports == nil || l.Filter.BExports == nil {
				return fmt.Errorf("%s: filter must declare both a-exports and b-exports", where)
			}
			for _, name := range l.Filter.AExports {
				if !t.knownExport(name) {
					return fmt.Errorf("%s: unknown export entity %q", where, name)
				}
			}
			for _, name := range l.Filter.BExports {
				if !t.knownExport(name) {
					return fmt.Errorf("%s: unknown export entity %q", where, name)
				}
			}
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

// validateSets checks set names don't collide with subnet/network names
// (rules reference all of them in one flat namespace), subnet references
// exist, and every address falls inside exactly one known subnet.
func (t *Topology) validateSets() error {
	for _, name := range sortedSetNames(t.Sets) {
		s := t.Sets[name]
		if _, ok := t.Subnets[name]; ok {
			return fmt.Errorf("set %q: name collides with subnet %q", name, name)
		}
		if _, ok := t.Networks[name]; ok {
			return fmt.Errorf("set %q: name collides with network %q", name, name)
		}
		if len(s.Subnets) == 0 && len(s.Addresses) == 0 {
			return fmt.Errorf("set %q: must contain at least one subnet or address", name)
		}
		for _, ref := range s.Subnets {
			if _, ok := t.Subnets[ref]; !ok {
				return fmt.Errorf("set %q: unknown subnet %q", name, ref)
			}
		}
		for _, addr := range s.Addresses {
			if _, ok := t.subnetContaining(addr); !ok {
				return fmt.Errorf("set %q: address %s is outside every known subnet", name, addr)
			}
		}
	}
	return nil
}

// validateUnions checks member references exist and every device/network is
// a member of at most one union.
func (t *Topology) validateUnions() error {
	devOwner := make(map[string]string, len(t.Devices))
	netOwner := make(map[string]string, len(t.Networks))
	for _, name := range sortedUnionNames(t.Unions) {
		s := t.Unions[name]
		for _, d := range s.Devices {
			if _, ok := t.Devices[d]; !ok {
				return fmt.Errorf("union %q: unknown device %q", name, d)
			}
			if prev, ok := devOwner[d]; ok {
				return fmt.Errorf("device %q belongs to both union %q and %q", d, prev, name)
			}
			devOwner[d] = name
		}
		for _, n := range s.Networks {
			if _, ok := t.Networks[n]; !ok {
				return fmt.Errorf("union %q: unknown network %q", name, n)
			}
			if prev, ok := netOwner[n]; ok {
				return fmt.Errorf("network %q belongs to both union %q and %q", n, prev, name)
			}
			netOwner[n] = name
		}
	}
	return nil
}

func sortedUnionNames(m map[string]Union) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// knownExport reports whether name may appear in a link filter's export
// list: networks and bare subnets qualify, sets do not.
func (t *Topology) knownExport(name string) bool {
	_, isSubnet := t.Subnets[name]
	_, isNetwork := t.Networks[name]
	return isSubnet || isNetwork
}

// subnetContaining returns the name of the unique known subnet whose CIDR
// contains prefix (subnets are validated non-overlapping).
func (t *Topology) subnetContaining(p netip.Prefix) (string, bool) {
	for _, name := range sortedSubnetNames(t.Subnets) {
		if t.Subnets[name].CIDR.Contains(p.Addr()) {
			return name, true
		}
	}
	return "", false
}

// ResolveNetwork flattens a subnet, network, or set name into the subnet
// names pathfinding should use: for a set that's its member subnets plus
// the subnets containing its addresses.
func (t *Topology) ResolveNetwork(name string) ([]string, error) {
	if _, ok := t.Subnets[name]; ok {
		return []string{name}, nil
	}
	n, ok := t.Networks[name]
	if ok {
		out := append([]string(nil), n.Subnets...)
		sort.Strings(out)
		return out, nil
	}
	s, ok := t.Sets[name]
	if ok {
		seen := make(map[string]struct{}, len(s.Subnets)+len(s.Addresses))
		out := make([]string, 0, len(s.Subnets)+len(s.Addresses))
		for _, sub := range s.Subnets {
			if _, dup := seen[sub]; !dup {
				seen[sub] = struct{}{}
				out = append(out, sub)
			}
		}
		for _, addr := range s.Addresses {
			if sub, ok := t.subnetContaining(addr); ok {
				if _, dup := seen[sub]; !dup {
					seen[sub] = struct{}{}
					out = append(out, sub)
				}
			}
		}
		sort.Strings(out)
		return out, nil
	}
	return nil, fmt.Errorf("unknown network, subnet, or set %q", name)
}

func sortedSetNames(m map[string]Set) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// EntityCIDRs returns the CIDR entries an ipset for name should contain:
// subnet CIDRs plus host addresses for a set, subnet CIDRs for a network
// or bare subnet.
func (t *Topology) EntityCIDRs(name string) []string {
	var out []string
	if s, ok := t.Sets[name]; ok {
		for _, ref := range s.Subnets {
			out = append(out, t.Subnets[ref].CIDR.String())
		}
		for _, addr := range s.Addresses {
			out = append(out, addr.String())
		}
		return out
	}
	subs, err := t.ResolveNetwork(name)
	if err != nil {
		return nil
	}
	for _, sub := range subs {
		out = append(out, t.Subnets[sub].CIDR.String())
	}
	return out
}

// SubnetsOverlapping returns the sorted names of declared subnets whose
// CIDR overlaps p — the placement anchors for a literally written endpoint.
func (t *Topology) SubnetsOverlapping(p netip.Prefix) []string {
	var out []string
	for name, s := range t.Subnets {
		if s.CIDR.Overlaps(p) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
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
