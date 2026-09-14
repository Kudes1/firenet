package db_test

import (
	"context"
	"testing"

	"github.com/kudes1/firenet/internal/db"
	"github.com/kudes1/firenet/internal/db/dbtest"
)

func TestMigrateCreatesUsersAndSessions(t *testing.T) {
	pool := dbtest.Open(t)

	var tableCount int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN ('users', 'sessions')`).Scan(&tableCount)
	if err != nil {
		t.Fatalf("query tables: %v", err)
	}
	if tableCount != 2 {
		t.Fatalf("got %d of the expected tables, want 2", tableCount)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	pool := dbtest.Open(t)

	if err := db.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("second Migrate call failed: %v", err)
	}
}
