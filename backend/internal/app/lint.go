package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/lint"
	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

// Lint runs the rule linter (internal/lint) against an already-loaded
// project. It validates pol against topo itself (mirroring Diagnose), so
// callers can pass pol straight from traces.Policy without validating first.
func Lint(_ context.Context, log *slog.Logger, topo *topology.Topology, pol *rules.Policy) ([]lint.Finding, error) {
	if err := pol.Validate(topo); err != nil {
		return nil, fmt.Errorf("invalid rules: %w", err)
	}
	findings := lint.Check(pol, topo)
	log.Debug("linted rules", "findings", len(findings))
	return findings, nil
}
