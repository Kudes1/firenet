package cli

import (
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/httpapi"
)

func newServeCmd() *cobra.Command {
	var topologyPath, subnetsPath, rulesPath, addr string
	var openBrowser bool

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Serve a local web UI for building topology, editing rules and compiling",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			log := loggerFromContext(ctx)

			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if cfg.DatabaseURL == "" {
				return fmt.Errorf("FIRENET_DATABASE_URL is required")
			}

			pool, err := db.Open(ctx, cfg.DatabaseURL)
			if err != nil {
				return fmt.Errorf("connect to database: %w", err)
			}
			defer pool.Close()
			if err := db.Migrate(ctx, pool); err != nil {
				return fmt.Errorf("apply migrations: %w", err)
			}

			users := auth.NewStore(pool)
			if err := users.BootstrapAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
				return fmt.Errorf("bootstrap admin account: %w", err)
			}

			store := httpapi.FileProjectStore{
				TopologyPath: topologyPath,
				SubnetsPath:  subnetsPath,
				RulesPath:    rulesPath,
				LayoutPath:   filepath.Join(filepath.Dir(topologyPath), ".firenet-layout.json"),
			}
			if err := store.EnsureSeeded(); err != nil {
				return fmt.Errorf("seed project files: %w", err)
			}

			srv := httpapi.NewServer(store, users, log)
			log.Info("serving firenet web UI", "addr", addr, "topology", topologyPath, "subnets", subnetsPath, "rules", rulesPath)

			if openBrowser {
				go openURL("http://" + addr)
			}
			return http.ListenAndServe(addr, srv)
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "topology.yaml", "path to topology YAML file")
	cmd.Flags().StringVar(&subnetsPath, "subnets", "subnets.yaml", "path to subnets YAML file")
	cmd.Flags().StringVar(&rulesPath, "rules", "rules.yaml", "path to rules YAML file")
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address to listen on")
	cmd.Flags().BoolVar(&openBrowser, "open", false, "open the UI in a browser on start")

	return cmd
}

// openURL best-effort launches the OS default browser; failures are silent
// since this is a convenience, not a requirement.
func openURL(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
