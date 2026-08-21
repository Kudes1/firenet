package rules

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/topology"
)

// Validate checks that every rule references a real subnet/zone (or Any),
// uses a valid proto/action, and only carries ports for tcp/udp.
func (p *Policy) Validate(topo *topology.Topology) error {
	if p.DefaultAction != ActionAllow && p.DefaultAction != ActionDeny {
		return fmt.Errorf("invalid defaultAction %q", p.DefaultAction)
	}

	seen := make(map[string]struct{}, len(p.Rules))
	for i, r := range p.Rules {
		where := fmt.Sprintf("rule[%d]", i)
		if r.Name == "" {
			return fmt.Errorf("%s: name is required", where)
		}
		if _, dup := seen[r.Name]; dup {
			return fmt.Errorf("rule %q: duplicate name", r.Name)
		}
		seen[r.Name] = struct{}{}

		if len(r.Src) == 0 || len(r.Dst) == 0 {
			return fmt.Errorf("rule %q: src and dst must not be empty", r.Name)
		}
		for _, s := range r.Src {
			if !validEndpoint(topo, s) {
				return fmt.Errorf("rule %q: unknown src %q", r.Name, s)
			}
		}
		for _, d := range r.Dst {
			if !validEndpoint(topo, d) {
				return fmt.Errorf("rule %q: unknown dst %q", r.Name, d)
			}
		}

		switch r.Proto {
		case ProtoAny, ProtoTCP, ProtoUDP, ProtoICMP:
		default:
			return fmt.Errorf("rule %q: invalid proto %q", r.Name, r.Proto)
		}
		if (len(r.SrcPorts) > 0 || len(r.DstPorts) > 0) && r.Proto != ProtoTCP && r.Proto != ProtoUDP {
			return fmt.Errorf("rule %q: ports only valid for tcp/udp", r.Name)
		}
		if err := validatePortList(r.SrcPorts); err != nil {
			return fmt.Errorf("rule %q: %w", r.Name, err)
		}
		if err := validatePortList(r.DstPorts); err != nil {
			return fmt.Errorf("rule %q: %w", r.Name, err)
		}

		if r.Action != ActionAllow && r.Action != ActionDeny {
			return fmt.Errorf("rule %q: invalid action %q", r.Name, r.Action)
		}
	}
	return nil
}

func validEndpoint(topo *topology.Topology, name string) bool {
	if name == Any {
		return true
	}
	if _, ok := topo.Subnets[name]; ok {
		return true
	}
	if _, ok := topo.Zones[name]; ok {
		return true
	}
	return false
}

func validatePortList(ports []string) error {
	for _, port := range ports {
		if err := validatePortSpec(port); err != nil {
			return err
		}
	}
	return nil
}

func validatePortSpec(spec string) error {
	parts := strings.SplitN(spec, "-", 2)
	nums := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("invalid port spec %q", spec)
		}
		nums = append(nums, n)
	}
	if len(nums) == 2 && nums[0] > nums[1] {
		return fmt.Errorf("invalid port range %q: from > to", spec)
	}
	return nil
}
