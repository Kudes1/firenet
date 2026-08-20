package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/app"
)

func newCompileCmd() *cobra.Command {
	var topologyPath, rulesPath, outDir, deviceFilter string
	var toStdout bool
	var maxHops, maxPaths int

	cmd := &cobra.Command{
		Use:   "compile",
		Short: "Compile topology and rules into per-device iptables/ipset scripts",
		RunE: func(cmd *cobra.Command, args []string) error {
			topoYAML, err := os.ReadFile(topologyPath)
			if err != nil {
				return fmt.Errorf("read topology file: %w", err)
			}
			rulesYAML, err := os.ReadFile(rulesPath)
			if err != nil {
				return fmt.Errorf("read rules file: %w", err)
			}

			devices, err := app.Compile(cmd.Context(), loggerFromContext(cmd.Context()), app.CompileOptions{
				TopologyYAML: topoYAML,
				RulesYAML:    rulesYAML,
				MaxHops:      maxHops,
				MaxPaths:     maxPaths,
			})
			if err != nil {
				return err
			}

			for _, d := range devices {
				if deviceFilter != "" && d.Name != deviceFilter {
					continue
				}
				if toStdout {
					fmt.Fprintf(cmd.OutOrStdout(), "# %s.ipsets.restore\n%s\n# %s.rules.sh\n%s\n", d.Name, d.IPSetsScript, d.Name, d.RulesScript)
					continue
				}
				if err := writeDeviceOutput(outDir, d); err != nil {
					return err
				}
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "", "path to topology YAML file (required)")
	cmd.Flags().StringVar(&rulesPath, "rules", "", "path to rules YAML file (required)")
	cmd.Flags().StringVar(&outDir, "out", "./out", "output directory for per-device scripts")
	cmd.Flags().BoolVar(&toStdout, "stdout", false, "print output to stdout instead of writing files")
	cmd.Flags().StringVar(&deviceFilter, "device", "", "only output this device")
	cmd.Flags().IntVar(&maxHops, "max-hops", 0, "override the max path length (0 = default)")
	cmd.Flags().IntVar(&maxPaths, "max-paths", 0, "override the max paths per subnet pair (0 = default)")
	_ = cmd.MarkFlagRequired("topology")
	_ = cmd.MarkFlagRequired("rules")

	return cmd
}

func writeDeviceOutput(outDir string, d app.CompiledDevice) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, d.Name+".ipsets.restore"), []byte(d.IPSetsScript), 0o644); err != nil {
		return fmt.Errorf("write ipsets for %s: %w", d.Name, err)
	}
	if err := os.WriteFile(filepath.Join(outDir, d.Name+".rules.sh"), []byte(d.RulesScript), 0o755); err != nil {
		return fmt.Errorf("write rules for %s: %w", d.Name, err)
	}
	return nil
}
