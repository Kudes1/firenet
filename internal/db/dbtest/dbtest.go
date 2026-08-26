// Package dbtest gives tests a migrated Postgres connection, skipping
// gracefully when no test database is configured.
package dbtest

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kudes1/firenet/internal/db"
)

// Open returns a migrated pool for the calling test, backed by
// FIRENET_TEST_DATABASE_URL. If that env var is unset, the test is
// skipped. Tables that hold per-test data are truncated via t.Cleanup;
// schema_migrations is left alone so Migrate stays a cheap no-op across
// tests. Later plans extend the truncate list as they add tables.
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("FIRENET_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("FIRENET_TEST_DATABASE_URL not set; skipping Postgres-backed test")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("migrate test database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "TRUNCATE users, sessions RESTART IDENTITY CASCADE")
		pool.Close()
	})
	return pool
}
