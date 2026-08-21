package cli

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/app"
	"github.com/kudes1/firenet/internal/rules"
)

func newValidateCmd() *cobra.Command {
	var topologyPath, subnetsPath, rulesPath string

	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate topology, subnets and rules files without compiling",
		RunE: func(cmd *cobra.Command, args []string) error {
			topoYAML, err := os.ReadFile(topologyPath)
			if err != nil {
				return fmt.Errorf("read topology file: %w", err)
			}
			subnetsYAML, err := os.ReadFile(subnetsPath)
			if err != nil {
				return fmt.Errorf("read subnets file: %w", err)
			}
			topo, err := app.LoadProject(topoYAML, subnetsYAML)
			if err != nil {
				return err
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
	cmd.Flags().StringVar(&subnetsPath, "subnets", "", "path to subnets YAML file (required)")
	cmd.Flags().StringVar(&rulesPath, "rules", "", "path to rules YAML file (required)")
	_ = cmd.MarkFlagRequired("topology")
	_ = cmd.MarkFlagRequired("subnets")
	_ = cmd.MarkFlagRequired("rules")

	return cmd
}
