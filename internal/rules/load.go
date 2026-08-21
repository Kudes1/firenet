package rules

import (
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

type yamlRule struct {
	Name     string   `yaml:"name"`
	Src      []string `yaml:"src"`
	Dst      []string `yaml:"dst"`
	Proto    string   `yaml:"proto"`
	SrcPorts []string `yaml:"srcPorts,omitempty"`
	DstPorts []string `yaml:"dstPorts,omitempty"`
	Action   string   `yaml:"action"`
	Mirror   bool     `yaml:"mirror,omitempty"`
}

type yamlPolicy struct {
	DefaultAction string     `yaml:"defaultAction"`
	ChainName     string     `yaml:"chainName,omitempty"`
	ChainPosition string     `yaml:"chainPosition,omitempty"`
	Rules         []yamlRule `yaml:"rules"`
}

// Load decodes a rules.yaml document. It does not call Validate.
func Load(r io.Reader) (*Policy, error) {
	dec := yaml.NewDecoder(r)
	dec.KnownFields(true)
	var raw yamlPolicy
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode rules yaml: %w", err)
	}

	pol := &Policy{
		DefaultAction: Action(raw.DefaultAction),
		ChainName:     raw.ChainName,
		ChainPosition: ChainPosition(raw.ChainPosition),
	}
	if pol.DefaultAction == "" {
		pol.DefaultAction = ActionDeny
	}
	if pol.ChainName == "" {
		pol.ChainName = DefaultChainName
	}
	if pol.ChainPosition == "" {
		pol.ChainPosition = ChainTop
	}

	for _, r := range raw.Rules {
		proto := Proto(r.Proto)
		if proto == "" {
			proto = ProtoAny
		}
		pol.Rules = append(pol.Rules, Rule{
			Name:     r.Name,
			Src:      r.Src,
			Dst:      r.Dst,
			Proto:    proto,
			SrcPorts: r.SrcPorts,
			DstPorts: r.DstPorts,
			Action:   Action(r.Action),
			Mirror:   r.Mirror,
		})
	}
	return pol, nil
}
