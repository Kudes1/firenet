package rules

import (
	"bytes"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

type yamlRule struct {
	Name     string   `yaml:"name"`
	Comment  string   `yaml:"comment,omitempty"`
	Src      []string `yaml:"src"`
	Dst      []string `yaml:"dst"`
	Proto    string   `yaml:"proto"`
	SrcPorts []string `yaml:"srcPorts,omitempty"`
	DstPorts []string `yaml:"dstPorts,omitempty"`
	Action   string   `yaml:"action"`
	JumpTo   string   `yaml:"jumpTo,omitempty"`
	Mirror   bool     `yaml:"mirror,omitempty"`
}

type yamlChain struct {
	Name          string     `yaml:"name"`
	DefaultAction string     `yaml:"defaultAction"`
	ChainPosition string     `yaml:"chainPosition,omitempty"`
	Rules         []yamlRule `yaml:"rules"`
}

type yamlPolicyModern struct {
	Chains []yamlChain `yaml:"chains"`
}

// yamlPolicyLegacy is the pre-chains flat document shape.
type yamlPolicyLegacy struct {
	DefaultAction string     `yaml:"defaultAction"`
	ChainName     string     `yaml:"chainName,omitempty"`
	ChainPosition string     `yaml:"chainPosition,omitempty"`
	Rules         []yamlRule `yaml:"rules"`
}

// Load decodes a rules.yaml document in either the chains format or the
// legacy flat format (read as a single primary chain). It does not call Validate.
func Load(r io.Reader) (*Policy, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read rules yaml: %w", err)
	}
	if pol, ok := decodeModern(raw); ok {
		return pol, nil
	}
	return decodeLegacy(raw)
}

func decodeModern(raw []byte) (*Policy, bool) {
	var ym yamlPolicyModern
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&ym); err != nil || len(ym.Chains) == 0 {
		return nil, false
	}
	pol := &Policy{}
	for i, c := range ym.Chains {
		ch := Chain{
			Name:          c.Name,
			DefaultAction: Action(c.DefaultAction),
			ChainPosition: ChainPosition(c.ChainPosition),
		}
		if ch.DefaultAction == "" {
			ch.DefaultAction = ActionDeny
		}
		if i == 0 {
			if ch.Name == "" {
				ch.Name = DefaultChainName
			}
			if ch.ChainPosition == "" {
				ch.ChainPosition = ChainTop
			}
		}
		ch.Rules = decodeRules(c.Rules)
		pol.Chains = append(pol.Chains, ch)
	}
	return pol, true
}

func decodeLegacy(raw []byte) (*Policy, error) {
	var yl yamlPolicyLegacy
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&yl); err != nil {
		return nil, fmt.Errorf("decode rules yaml: %w", err)
	}
	def := Action(yl.DefaultAction)
	if def == "" {
		def = ActionDeny
	}
	pos := ChainPosition(yl.ChainPosition)
	if pos == "" {
		pos = ChainTop
	}
	name := yl.ChainName
	if name == "" {
		name = DefaultChainName
	}
	return &Policy{Chains: []Chain{{
		Name:          name,
		DefaultAction: def,
		ChainPosition: pos,
		Rules:         decodeRules(yl.Rules),
	}}}, nil
}

func decodeRules(in []yamlRule) []Rule {
	var out []Rule
	for _, r := range in {
		proto := Proto(r.Proto)
		if proto == "" {
			proto = ProtoAny
		}
		out = append(out, Rule{
			Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
			Proto: proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
			Action: Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
		})
	}
	return out
}
