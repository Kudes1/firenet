package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/rules"
)

type DiagnoseOptions struct {
	TopologyYAML []byte
	SubnetsYAML  []byte
	RulesYAML    []byte
	MaxHops      int // 0 = use graph.DefaultLimits()
	MaxPaths     int // 0 = use graph.DefaultLimits()
	Flow         diagnose.Flow
}

// Diagnose answers "how would traffic from opts.Flow.Src to opts.Flow.Dst
// flow": it runs the same load -> build -> compile pipeline as Compile, then
// reports every simple path between the resolved endpoint subnets together
// with a per-router verdict over the compiled rules.
func Diagnose(_ context.Context, log *slog.Logger, opts DiagnoseOptions) (*diagnose.Report, error) {
	topo, err := LoadProject(opts.TopologyYAML, opts.SubnetsYAML)
	if err != nil {
		return nil, err
	}
	pol, err := rules.Load(bytes.NewReader(opts.RulesYAML))
	if err != nil {
		return nil, fmt.Errorf("load rules: %w", err)
	}
	if err := pol.Validate(topo); err != nil {
		return nil, fmt.Errorf("invalid rules: %w", err)
	}
	g, err := graph.Build(topo)
	if err != nil {
		return nil, fmt.Errorf("build graph: %w", err)
	}

	limits := graph.DefaultLimits()
	if opts.MaxHops > 0 {
		limits.MaxHops = opts.MaxHops
	}
	if opts.MaxPaths > 0 {
		limits.MaxPaths = opts.MaxPaths
	}

	devices, err := compiler.Compile(topo, pol, g, limits)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}

	log.Debug("diagnosed flow", "src", opts.Flow.Src, "dst", opts.Flow.Dst)
	return diagnose.Run(topo, devices, g, limits, opts.Flow)
}
