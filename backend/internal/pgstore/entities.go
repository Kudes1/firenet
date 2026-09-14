// Package pgstore is the Postgres-backed home for a firenet project's
// version history and personal drafts. It maps projectdoc.ProjectDoc to
// and from flat (kind, key) -> data entity rows, so that two edits to
// different entities never conflict even if they land in the same YAML
// file, and one entity's whole history can be reconstructed on its own.
package pgstore

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/kudes1/firenet/internal/projectdoc"
)

const (
	kindDevice        = "device"
	kindLink          = "link"
	kindNetwork       = "network"
	kindSet           = "set"
	kindUnion         = "union"
	kindSubnet        = "subnet"
	kindChain         = "chain"
	kindRule          = "rule"
	kindLayoutDevice  = "layout_device"
	kindLayoutNetwork = "layout_network"
	kindLayoutLink    = "layout_link"
	kindLayoutCamera  = "layout_camera"
)

// layoutCameraKey is the single (kind=layout_camera) entity's key — there
// is at most one camera per project.
const layoutCameraKey = ""

type entityRef struct {
	Kind string
	Key  string
}

// entityRow is one entity's state at some point in the history: either
// its current data, or a tombstone (Change == "removed", Data == nil).
type entityRow struct {
	Change string
	Data   json.RawMessage
}

// linkKey is the entity identity for a link (and its layout waypoints):
// the endpoint pair, order-normalized the same way
// internal/topology/validate.go does when rejecting duplicate links.
func linkKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

// chainRuleEntity is the envelope stored for a "rule" entity: the rule
// itself plus its position within the chain, since entity rows have no
// inherent order and rule order is firewall-semantically significant
// (first match wins).
type chainRuleEntity struct {
	Order int                `json:"order"`
	Rule  projectdoc.RuleDoc `json:"rule"`
}

// chainEntity is the envelope for a "chain" entity: chain metadata (never
// its Rules, which are separate "rule" entities) plus its position among
// the policy's chains (index 0 is always the primary chain).
type chainEntity struct {
	Order         int    `json:"order"`
	Name          string `json:"name"`
	DefaultAction string `json:"defaultAction"`
	ChainPosition string `json:"chainPosition,omitempty"`
}

func marshalEntity(v any) (json.RawMessage, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal entity: %w", err)
	}
	return b, nil
}

// toEntities flattens a ProjectDoc into the full set of entities it
// implies: every key present here is "should exist with this data".
// Callers diff this against a base snapshot to find what changed.
func toEntities(doc projectdoc.ProjectDoc) (map[entityRef]json.RawMessage, error) {
	out := map[entityRef]json.RawMessage{}
	put := func(kind, key string, v any) error {
		data, err := marshalEntity(v)
		if err != nil {
			return err
		}
		out[entityRef{Kind: kind, Key: key}] = data
		return nil
	}

	for _, d := range doc.Topology.Devices {
		if err := put(kindDevice, d.Name, d); err != nil {
			return nil, err
		}
	}
	for _, l := range doc.Topology.Links {
		if err := put(kindLink, linkKey(l.A.Device, l.B.Device), l); err != nil {
			return nil, err
		}
	}
	for _, n := range doc.Topology.Networks {
		if err := put(kindNetwork, n.Name, n); err != nil {
			return nil, err
		}
	}
	for _, s := range doc.Topology.Sets {
		if err := put(kindSet, s.Name, s); err != nil {
			return nil, err
		}
	}
	for _, u := range doc.Topology.Unions {
		if err := put(kindUnion, u.Name, u); err != nil {
			return nil, err
		}
	}
	for _, s := range doc.Subnets.Subnets {
		if err := put(kindSubnet, s.Name, s); err != nil {
			return nil, err
		}
	}
	for ci, c := range doc.Rules.Chains {
		ce := chainEntity{Order: ci, Name: c.Name, DefaultAction: c.DefaultAction, ChainPosition: c.ChainPosition}
		if err := put(kindChain, c.Name, ce); err != nil {
			return nil, err
		}
		for ri, r := range c.Rules {
			re := chainRuleEntity{Order: ri, Rule: r}
			if err := put(kindRule, c.Name+"::"+r.Name, re); err != nil {
				return nil, err
			}
		}
	}
	for name, p := range doc.Layout.Devices {
		if err := put(kindLayoutDevice, name, p); err != nil {
			return nil, err
		}
	}
	for name, p := range doc.Layout.Networks {
		if err := put(kindLayoutNetwork, name, p); err != nil {
			return nil, err
		}
	}
	for key, waypoints := range doc.Layout.Links {
		if err := put(kindLayoutLink, key, waypoints); err != nil {
			return nil, err
		}
	}
	if doc.Layout.Camera != nil {
		if err := put(kindLayoutCamera, layoutCameraKey, doc.Layout.Camera); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// fromEntities reconstructs a ProjectDoc from a snapshot (one row per
// live (kind, key); rows with Change == "removed" are ignored). Every
// kind except chain/rule is sorted by key for a stable, deterministic
// order; chains and rules use their stored Order.
func fromEntities(snapshot map[entityRef]entityRow) (projectdoc.ProjectDoc, error) {
	var doc projectdoc.ProjectDoc

	type ordered[T any] struct {
		key   string
		order int
		value T
	}
	sortByKey := func(keys []string) { sort.Strings(keys) }

	var deviceKeys, linkKeys, networkKeys, setKeys, unionKeys, subnetKeys []string
	var layoutDeviceKeys, layoutNetworkKeys, layoutLinkKeys []string
	var chains []ordered[chainEntity]
	rulesByChain := map[string][]ordered[projectdoc.RuleDoc]{}

	for ref, row := range snapshot {
		if row.Change == "removed" {
			continue
		}
		switch ref.Kind {
		case kindDevice:
			deviceKeys = append(deviceKeys, ref.Key)
		case kindLink:
			linkKeys = append(linkKeys, ref.Key)
		case kindNetwork:
			networkKeys = append(networkKeys, ref.Key)
		case kindSet:
			setKeys = append(setKeys, ref.Key)
		case kindUnion:
			unionKeys = append(unionKeys, ref.Key)
		case kindSubnet:
			subnetKeys = append(subnetKeys, ref.Key)
		case kindChain:
			var ce chainEntity
			if err := json.Unmarshal(row.Data, &ce); err != nil {
				return doc, fmt.Errorf("unmarshal chain %q: %w", ref.Key, err)
			}
			chains = append(chains, ordered[chainEntity]{key: ref.Key, order: ce.Order, value: ce})
		case kindRule:
			chainName, _, ok := cutRuleKey(ref.Key)
			if !ok {
				return doc, fmt.Errorf("malformed rule key %q", ref.Key)
			}
			var re chainRuleEntity
			if err := json.Unmarshal(row.Data, &re); err != nil {
				return doc, fmt.Errorf("unmarshal rule %q: %w", ref.Key, err)
			}
			rulesByChain[chainName] = append(rulesByChain[chainName], ordered[projectdoc.RuleDoc]{key: ref.Key, order: re.Order, value: re.Rule})
		case kindLayoutDevice:
			layoutDeviceKeys = append(layoutDeviceKeys, ref.Key)
		case kindLayoutNetwork:
			layoutNetworkKeys = append(layoutNetworkKeys, ref.Key)
		case kindLayoutLink:
			layoutLinkKeys = append(layoutLinkKeys, ref.Key)
		case kindLayoutCamera:
			var cam projectdoc.LayoutCamera
			if err := json.Unmarshal(row.Data, &cam); err != nil {
				return doc, fmt.Errorf("unmarshal camera: %w", err)
			}
			doc.Layout.Camera = &cam
		default:
			return doc, fmt.Errorf("unknown entity kind %q", ref.Kind)
		}
	}

	sortByKey(deviceKeys)
	for _, k := range deviceKeys {
		var v projectdoc.DeviceDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindDevice, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal device %q: %w", k, err)
		}
		doc.Topology.Devices = append(doc.Topology.Devices, v)
	}
	sortByKey(linkKeys)
	for _, k := range linkKeys {
		var v projectdoc.LinkDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLink, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal link %q: %w", k, err)
		}
		doc.Topology.Links = append(doc.Topology.Links, v)
	}
	sortByKey(networkKeys)
	for _, k := range networkKeys {
		var v projectdoc.NetworkDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindNetwork, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal network %q: %w", k, err)
		}
		doc.Topology.Networks = append(doc.Topology.Networks, v)
	}
	sortByKey(setKeys)
	for _, k := range setKeys {
		var v projectdoc.SetDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindSet, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal set %q: %w", k, err)
		}
		doc.Topology.Sets = append(doc.Topology.Sets, v)
	}
	sortByKey(unionKeys)
	for _, k := range unionKeys {
		var v projectdoc.UnionDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindUnion, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal union %q: %w", k, err)
		}
		doc.Topology.Unions = append(doc.Topology.Unions, v)
	}
	sortByKey(subnetKeys)
	for _, k := range subnetKeys {
		var v projectdoc.SubnetDoc
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindSubnet, Key: k}].Data, &v); err != nil {
			return doc, fmt.Errorf("unmarshal subnet %q: %w", k, err)
		}
		doc.Subnets.Subnets = append(doc.Subnets.Subnets, v)
	}

	sort.Slice(chains, func(i, j int) bool { return chains[i].order < chains[j].order })
	for _, c := range chains {
		rs := rulesByChain[c.key]
		sort.Slice(rs, func(i, j int) bool { return rs[i].order < rs[j].order })
		chainDoc := projectdoc.ChainDoc{
			Name: c.value.Name, DefaultAction: c.value.DefaultAction, ChainPosition: c.value.ChainPosition,
			Rules: make([]projectdoc.RuleDoc, len(rs)),
		}
		for i, r := range rs {
			chainDoc.Rules[i] = r.value
		}
		doc.Rules.Chains = append(doc.Rules.Chains, chainDoc)
	}

	sortByKey(layoutDeviceKeys)
	for _, k := range layoutDeviceKeys {
		var p projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutDevice, Key: k}].Data, &p); err != nil {
			return doc, fmt.Errorf("unmarshal layout device %q: %w", k, err)
		}
		if doc.Layout.Devices == nil {
			doc.Layout.Devices = map[string]projectdoc.LayoutPoint{}
		}
		doc.Layout.Devices[k] = p
	}
	sortByKey(layoutNetworkKeys)
	for _, k := range layoutNetworkKeys {
		var p projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutNetwork, Key: k}].Data, &p); err != nil {
			return doc, fmt.Errorf("unmarshal layout network %q: %w", k, err)
		}
		if doc.Layout.Networks == nil {
			doc.Layout.Networks = map[string]projectdoc.LayoutPoint{}
		}
		doc.Layout.Networks[k] = p
	}
	sortByKey(layoutLinkKeys)
	for _, k := range layoutLinkKeys {
		var wp [][]projectdoc.LayoutPoint
		if err := json.Unmarshal(snapshot[entityRef{Kind: kindLayoutLink, Key: k}].Data, &wp); err != nil {
			return doc, fmt.Errorf("unmarshal layout link %q: %w", k, err)
		}
		if doc.Layout.Links == nil {
			doc.Layout.Links = map[string][][]projectdoc.LayoutPoint{}
		}
		doc.Layout.Links[k] = wp
	}

	return doc, nil
}

// cutRuleKey splits a "chain::rule" entity key.
func cutRuleKey(key string) (chain, rule string, ok bool) {
	for i := 0; i+1 < len(key); i++ {
		if key[i] == ':' && key[i+1] == ':' {
			return key[:i], key[i+2:], true
		}
	}
	return "", "", false
}
