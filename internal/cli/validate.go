package cli

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/rules"
	"github.com/kudes1/firenet/internal/topology"
)

func newValidateCmd() *cobra.Command {
	var topologyPath, rulesPath string

	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate topology and rules files without compiling",
		RunE: func(cmd *cobra.Command, args []string) error {
			topoYAML, err := os.ReadFile(topologyPath)
			if err != nil {
				return fmt.Errorf("read topology file: %w", err)
			}
			topo, err := topology.Load(bytes.NewReader(topoYAML))
			if err != nil {
				return fmt.Errorf("load topology: %w", err)
			}
			if err := topo.Validate(); err != nil {
				return fmt.Errorf("invalid topology: %w", err)
			}

			rulesYAML, err := os.ReadFile(rulesPath)
			if err != nil {
				return fmt.Errorf("read rules file: %w", err)
			}
			pol, err := rules.Load(bytes.NewReader(rulesYAML))
			if err != nil {
				return fmt.Errorf("load rules: %w", err)
			}
			if err := pol.Validate(topo); err != nil {
				return fmt.Errorf("invalid rules: %w", err)
			}

			fmt.Fprintln(cmd.OutOrStdout(), "OK")
			return nil
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "", "path to topology YAML file (required)")
	cmd.Flags().StringVar(&rulesPath, "rules", "", "path to rules YAML file (required)")
	_ = cmd.MarkFlagRequired("topology")
	_ = cmd.MarkFlagRequired("rules")

	return cmd
}
