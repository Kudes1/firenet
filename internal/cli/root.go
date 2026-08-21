// Package cli wires firenet's core logic to a command-line interface.
package cli

import (
	"context"
	"log/slog"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/logger"
)

type loggerKey struct{}

// loggerFromContext returns the logger attached to ctx by the root command.
func loggerFromContext(ctx context.Context) *slog.Logger {
	log, _ := ctx.Value(loggerKey{}).(*slog.Logger)
	return log
}

// Execute builds and runs the root command.
func Execute() error {
	return NewRootCmd().Execute()
}

// NewRootCmd builds firenet's root cobra command.
func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "firenet",
		Short:         "firenet CLI",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			log := logger.New(cfg)
			cmd.SetContext(context.WithValue(cmd.Context(), loggerKey{}, log))
			return nil
		},
	}

	root.AddCommand(newVersionCmd())
	root.AddCommand(newCompileCmd())
	root.AddCommand(newValidateCmd())
	root.AddCommand(newServeCmd())

	return root
}
