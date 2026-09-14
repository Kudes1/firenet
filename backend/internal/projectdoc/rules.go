package projectdoc

import "github.com/kudes1/firenet/internal/rules"

// RuleDoc matches traffic between named subnets/zones (or "any").
type RuleDoc struct {
	Name     string   `json:"name" yaml:"name"`
	Comment  string   `json:"comment,omitempty" yaml:"comment,omitempty"`
	Src      []string `json:"src" yaml:"src"`
	Dst      []string `json:"dst" yaml:"dst"`
	Proto    string   `json:"proto,omitempty" yaml:"proto,omitempty"`
	SrcPorts []string `json:"srcPorts,omitempty" yaml:"srcPorts,omitempty"`
	DstPorts []string `json:"dstPorts,omitempty" yaml:"dstPorts,omitempty"`
	Action   string   `json:"action" yaml:"action"`
	JumpTo   string   `json:"jumpTo,omitempty" yaml:"jumpTo,omitempty"`
	Mirror   bool     `json:"mirror,omitempty" yaml:"mirror,omitempty"`
}

// ChainDoc is one named chain of the policy wire format. The first element
// of PolicyDoc.Chains is the primary chain (its jump lands in FORWARD).
type ChainDoc struct {
	Name          string    `json:"name" yaml:"name"`
	DefaultAction string    `json:"defaultAction" yaml:"defaultAction"`
	ChainPosition string    `json:"chainPosition,omitempty" yaml:"chainPosition,omitempty"`
	Rules         []RuleDoc `json:"rules" yaml:"rules"`
}

// PolicyDoc is the full wire shape of rules.yaml (chains format).
type PolicyDoc struct {
	Chains []ChainDoc `json:"chains" yaml:"chains"`
}

// ToPolicy converts the wire doc to the domain model.
func (d PolicyDoc) ToPolicy() rules.Policy {
	pol := rules.Policy{}
	for i, c := range d.Chains {
		ch := rules.Chain{
			Name:          c.Name,
			DefaultAction: rules.Action(c.DefaultAction),
			ChainPosition: rules.ChainPosition(c.ChainPosition),
		}
		if ch.DefaultAction == "" {
			ch.DefaultAction = rules.ActionDeny
		}
		if i == 0 {
			if ch.Name == "" {
				ch.Name = rules.DefaultChainName
			}
			if ch.ChainPosition == "" {
				ch.ChainPosition = rules.ChainTop
			}
		}
		for _, r := range c.Rules {
			proto := rules.Proto(r.Proto)
			if proto == "" {
				proto = rules.ProtoAny
			}
			ch.Rules = append(ch.Rules, rules.Rule{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: rules.Action(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		pol.Chains = append(pol.Chains, ch)
	}
	return pol
}

// NewPolicyDoc converts the domain model to the wire doc.
func NewPolicyDoc(pol *rules.Policy) PolicyDoc {
	doc := PolicyDoc{}
	for i, c := range pol.Chains {
		ch := ChainDoc{
			Name:          c.Name,
			DefaultAction: string(c.DefaultAction),
			ChainPosition: string(c.ChainPosition),
			Rules:         []RuleDoc{},
		}
		if ch.DefaultAction == "" {
			ch.DefaultAction = string(rules.ActionDeny)
		}
		if i == 0 {
			if ch.Name == "" {
				ch.Name = rules.DefaultChainName
			}
			if ch.ChainPosition == "" {
				ch.ChainPosition = string(rules.ChainTop)
			}
		}
		for _, r := range c.Rules {
			proto := string(r.Proto)
			if proto == "" {
				proto = string(rules.ProtoAny)
			}
			ch.Rules = append(ch.Rules, RuleDoc{
				Name: r.Name, Comment: r.Comment, Src: r.Src, Dst: r.Dst,
				Proto: proto, SrcPorts: r.SrcPorts, DstPorts: r.DstPorts,
				Action: string(r.Action), JumpTo: r.JumpTo, Mirror: r.Mirror,
			})
		}
		doc.Chains = append(doc.Chains, ch)
	}
	return doc
}
