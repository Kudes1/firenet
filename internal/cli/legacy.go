package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"github.com/kudes1/firenet/internal/httpapi"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

// loadLegacyProjectDoc reads whatever topology.yaml/subnets.yaml/rules.yaml
// a pre-multiuser project left on disk, for the one-time import into
// version 1 (internal/pgstore.Store.SeedInitialVersion). A missing file
// yields the same empty-but-valid default httpapi.FileProjectStore.
// EnsureSeeded used to write for a brand-new project — layout has no
// such fallback to preserve: an empty projectdoc.LayoutDoc already
// serializes to "no layout yet", matching the old GET /api/layout
// behavior for a fresh project.
func loadLegacyProjectDoc(store httpapi.FileProjectStore) (projectdoc.ProjectDoc, error) {
	var doc projectdoc.ProjectDoc

	if raw, err := store.ReadTopology(); err == nil {
		if err := yaml.Unmarshal(raw, &doc.Topology); err != nil {
			return doc, fmt.Errorf("parse legacy topology: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return doc, fmt.Errorf("read legacy topology: %w", err)
	}

	if raw, err := store.ReadSubnets(); err == nil {
		if err := yaml.Unmarshal(raw, &doc.Subnets); err != nil {
			return doc, fmt.Errorf("parse legacy subnets: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return doc, fmt.Errorf("read legacy subnets: %w", err)
	}

	if raw, err := store.ReadRules(); err == nil {
		pol, err := rules.Load(bytes.NewReader(raw))
		if err != nil {
			return doc, fmt.Errorf("parse legacy rules: %w", err)
		}
		doc.Rules = projectdoc.NewPolicyDoc(pol)
	} else if os.IsNotExist(err) {
		doc.Rules = defaultPolicyDoc()
	} else {
		return doc, fmt.Errorf("read legacy rules: %w", err)
	}

	if raw, err := store.ReadLayout(); err == nil && len(raw) > 0 {
		// .firenet-layout.json is genuinely JSON (unlike the other three
		// files), matching how the old getLayout/putLayout handled it.
		if err := json.Unmarshal(raw, &doc.Layout); err != nil {
			return doc, fmt.Errorf("parse legacy layout: %w", err)
		}
	} else if err != nil {
		return doc, fmt.Errorf("read legacy layout: %w", err)
	}

	return doc, nil
}

func defaultPolicyDoc() projectdoc.PolicyDoc {
	return projectdoc.PolicyDoc{Chains: []projectdoc.ChainDoc{{
		Name:          rules.DefaultChainName,
		DefaultAction: "deny",
		ChainPosition: string(rules.ChainTop),
		Rules:         []projectdoc.RuleDoc{},
	}}}
}
