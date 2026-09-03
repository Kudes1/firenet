package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/diagnose"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/rules"
)

type DiagnoseOptions struct {
	Doc      projectdoc.ProjectDoc
	MaxHops  int // 0 = use graph.DefaultLimits()
	MaxPaths int // 0 = use graph.DefaultLimits()
	Flow     diagnose.Flow
}

// Diagnose answers "how would traffic from opts.Flow.Src to opts.Flow.Dst
// flow": it runs the same load -> build -> compile pipeline as Compile, then
// reports every simple path between the resolved endpoint subnets together
// with a per-router verdict over the compiled rules.
func Diagnose(_ context.Context, log *slog.Logger, opts DiagnoseOptions) (*diagnose.Report, error) {
	topo, err := LoadProject(opts.Doc)
	if err != nil {
		return nil, err
	}
	pol := opts.Doc.ToRules()
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

// SpreadOptions describes the network-propagation query over project doc.
type SpreadOptions struct {
	Doc      projectdoc.ProjectDoc
	MaxHops  int // 0 = use graph.DefaultLimits()
	MaxPaths int // 0 = use graph.DefaultLimits()
	Input    string
	Proto    rules.Proto
	DstPorts []string
}

// Spread answers "where does this network already propagate to" over the
// same load -> build -> compile pipeline as Diagnose: it resolves the input
// source, diagnoses every other subnet toward it, and merges the per-pair
// map marks into one picture.
func Spread(_ context.Context, log *slog.Logger, opts SpreadOptions) (*diagnose.SpreadResult, error) {
	topo, err := LoadProject(opts.Doc)
	if err != nil {
		return nil, err
	}
	pol := opts.Doc.ToRules()
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

	log.Debug("spread", "input", opts.Input)
	return diagnose.Spread(topo, devices, g, limits, diagnose.SpreadOptions{
		Input:    opts.Input,
		Proto:    opts.Proto,
		DstPorts: opts.DstPorts,
	})
}
