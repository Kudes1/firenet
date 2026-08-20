package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/app"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the firenet version",
		RunE: func(cmd *cobra.Command, args []string) error {
			log := loggerFromContext(cmd.Context())
			version := app.Version()
			log.Debug("resolved version", "version", version)
			_, err := fmt.Fprintln(cmd.OutOrStdout(), version)
			return err
		},
	}
}
