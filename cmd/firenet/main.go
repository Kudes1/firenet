// Command firenet runs the firenet web application.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/config"
	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/httpapi"
	"github.com/kudes1/firenet/internal/logger"
	"github.com/kudes1/firenet/internal/pgstore"
	"github.com/kudes1/firenet/internal/projectdoc"
)

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.DatabaseURL == "" {
		return fmt.Errorf("FIRENET_DATABASE_URL is required")
	}
	log := logger.New(cfg)

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

	projects := pgstore.NewStore(pool)
	if _, err := projects.SeedInitialVersion(ctx, projectdoc.ProjectDoc{}, actor); err != nil {
		return fmt.Errorf("seed initial version: %w", err)
	}

	srv := httpapi.NewServer(projects, users, log)
	log.Info("serving firenet web UI", "addr", cfg.Addr)
	return http.ListenAndServe(cfg.Addr, srv)
}
