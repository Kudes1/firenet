package rules

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/kudes1/firenet/internal/topology"
)

// chainNameRE matches iptables' own constraints on a user-defined chain
// name, with a small safety margin under the kernel's 29-byte limit.
var chainNameRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,28}$`)

// Validate checks every chain's rules and the jump graph between chains.
func (p *Policy) Validate(topo *topology.Topology) error {
	if len(p.Chains) == 0 {
		return fmt.Errorf("policy must declare at least one chain")
	}
	chainNames := make(map[string]struct{}, len(p.Chains))
	ruleNames := make(map[string]struct{})
	for i := range p.Chains {
		c := &p.Chains[i]
		where := fmt.Sprintf("chain[%d]", i)
		if !chainNameRE.MatchString(c.Name) {
			return fmt.Errorf("%s: invalid name %q", where, c.Name)
		}
		if _, dup := chainNames[c.Name]; dup {
			return fmt.Errorf("%s: duplicate chain name %q", where, c.Name)
		}
		chainNames[c.Name] = struct{}{}
		switch c.DefaultAction {
		case ActionAllow, ActionDeny, ActionReturn:
		default:
			return fmt.Errorf("%s %q: invalid defaultAction %q", where, c.Name, c.DefaultAction)
		}
		if i == 0 {
			if c.ChainPosition != ChainTop && c.ChainPosition != ChainBottom {
				return fmt.Errorf("%s %q: invalid chainPosition %q", where, c.Name, c.ChainPosition)
			}
		} else if c.ChainPosition != "" {
			return fmt.Errorf("%s %q: chainPosition is only valid on the first chain", where, c.Name)
		}
		for j, r := range c.Rules {
			if err := validateRule(topo, ruleNames, c.Name, r); err != nil {
				return fmt.Errorf("%s rule[%d]: %w", where, j, err)
			}
		}
	}
	return validateJumps(p, chainNames)
}

func validateRule(topo *topology.Topology, ruleNames map[string]struct{}, chain string, r Rule) error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if _, dup := ruleNames[r.Name]; dup {
		return fmt.Errorf("duplicate name %q", r.Name)
	}
	ruleNames[r.Name] = struct{}{}
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
	switch r.Action {
	case ActionAllow, ActionDeny, ActionReturn:
		if r.JumpTo != "" {
			return fmt.Errorf("rule %q: jumpTo is only valid with action jump", r.Name)
		}
	case ActionJump:
		if r.JumpTo == "" {
			return fmt.Errorf("rule %q: action jump requires jumpTo", r.Name)
		}
		if r.JumpTo == chain {
			return fmt.Errorf("rule %q: jump target must differ from the owning chain", r.Name)
		}
	default:
		return fmt.Errorf("rule %q: invalid action %q", r.Name, r.Action)
	}
	return nil
}

// validateJumps rejects jumps into unknown chains and cycles among them.
func validateJumps(p *Policy, chainNames map[string]struct{}) error {
	color := make(map[string]int) // 1 = in progress, 2 = done
	var visit func(name string, path []string) error
	visit = func(name string, path []string) error {
		switch color[name] {
		case 1:
			return fmt.Errorf("jump cycle: %s -> %s", strings.Join(path, " -> "), name)
		case 2:
			return nil
		}
		color[name] = 1
		for _, c := range p.Chains {
			if c.Name != name {
				continue
			}
			for _, r := range c.Rules {
				if r.Action != ActionJump {
					continue
				}
				if _, ok := chainNames[r.JumpTo]; !ok {
					return fmt.Errorf("rule %q: unknown jump target %q", r.Name, r.JumpTo)
				}
				if err := visit(r.JumpTo, append(path, name)); err != nil {
					return err
				}
			}
		}
		color[name] = 2
		return nil
	}
	for _, c := range p.Chains {
		if err := visit(c.Name, nil); err != nil {
			return err
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
	if _, ok := topo.Networks[name]; ok {
		return true
	}
	if _, ok := topo.Sets[name]; ok {
		return true
	}
	_, ok := topology.ParseEndpointPrefix(name)
	return ok
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
	if len(nums) == 2 && nums[0] >= nums[1] {
		return fmt.Errorf("invalid port range %q: from must be less than to", spec)
	}
	return nil
}
