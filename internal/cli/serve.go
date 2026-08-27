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
	"github.com/kudes1/firenet/internal/pgstore"
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

			// actor stays zero-value when cfg.AdminUsername is unset (every
			// run after the first) — SeedInitialVersion only dereferences it
			// when it's actually about to seed, which only happens once.
			var actor auth.User
			if cfg.AdminUsername != "" {
				actor, err = users.GetUserByUsername(ctx, cfg.AdminUsername)
				if err != nil {
					return fmt.Errorf("look up admin user: %w", err)
				}
			}

			legacyStore := httpapi.FileProjectStore{
				TopologyPath: topologyPath,
				SubnetsPath:  subnetsPath,
				RulesPath:    rulesPath,
				LayoutPath:   filepath.Join(filepath.Dir(topologyPath), ".firenet-layout.json"),
			}
			legacyDoc, err := loadLegacyProjectDoc(legacyStore)
			if err != nil {
				return fmt.Errorf("read legacy project files: %w", err)
			}

			projects := pgstore.NewStore(pool)
			if _, err := projects.SeedInitialVersion(ctx, legacyDoc, actor); err != nil {
				return fmt.Errorf("seed initial version: %w", err)
			}

			srv := httpapi.NewServer(projects, users, log)
			log.Info("serving firenet web UI", "addr", addr)

			if openBrowser {
				go openURL("http://" + addr)
			}
			return http.ListenAndServe(addr, srv)
		},
	}

	cmd.Flags().StringVar(&topologyPath, "topology", "topology.yaml", "path to a legacy topology YAML file to import on first run")
	cmd.Flags().StringVar(&subnetsPath, "subnets", "subnets.yaml", "path to a legacy subnets YAML file to import on first run")
	cmd.Flags().StringVar(&rulesPath, "rules", "rules.yaml", "path to a legacy rules YAML file to import on first run")
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
