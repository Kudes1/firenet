package rules

import (
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

type yamlRule struct {
	Name   string   `yaml:"name"`
	Src    []string `yaml:"src"`
	Dst    []string `yaml:"dst"`
	Proto  string   `yaml:"proto"`
	Ports  []string `yaml:"ports"`
	Action string   `yaml:"action"`
}

type yamlPolicy struct {
	DefaultAction string     `yaml:"defaultAction"`
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

	pol := &Policy{DefaultAction: Action(raw.DefaultAction)}
	if pol.DefaultAction == "" {
		pol.DefaultAction = ActionDeny
	}

	for _, r := range raw.Rules {
		proto := Proto(r.Proto)
		if proto == "" {
			proto = ProtoAny
		}
		pol.Rules = append(pol.Rules, Rule{
			Name:   r.Name,
			Src:    r.Src,
			Dst:    r.Dst,
			Proto:  proto,
			Ports:  r.Ports,
			Action: Action(r.Action),
		})
	}
	return pol, nil
}
