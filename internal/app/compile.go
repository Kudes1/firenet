package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"

	"github.com/kudes1/firenet/internal/compiler"
	"github.com/kudes1/firenet/internal/graph"
	"github.com/kudes1/firenet/internal/render"
	"github.com/kudes1/firenet/internal/rules"
)

// CompileOptions are the inputs to a single compile run.
type CompileOptions struct {
	TopologyYAML []byte
	SubnetsYAML  []byte
	RulesYAML    []byte
	MaxHops      int // 0 = use graph.DefaultLimits()
	MaxPaths     int // 0 = use graph.DefaultLimits()
}

// CompiledDevice is the rendered output for one managed device.
type CompiledDevice struct {
	Name         string
	IPSetsScript string
	RulesScript  string
}

// Compile loads topology+rules from YAML and compiles them into per-device
// iptables/ipset scripts. It takes and returns plain values only — no file
// or CLI knowledge — so both internal/cli today and a future internal/http
// adapter can call it directly.
func Compile(_ context.Context, log *slog.Logger, opts CompileOptions) ([]CompiledDevice, error) {
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
	log.Debug("compiled policy", "devices", len(devices))

	out := make([]CompiledDevice, 0, len(devices))
	for _, d := range devices {
		out = append(out, CompiledDevice{
			Name:         d.Device,
			IPSetsScript: string(render.RenderIPSets(d)),
			RulesScript:  string(render.RenderRules(d)),
		})
	}
	return out, nil
}
