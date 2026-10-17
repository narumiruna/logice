//go:build integration

package integration

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"time"

	"github.com/pressly/goose/v3"
)

func (s *stack) checkNonTransactionalFailure(ch *sql.DB) {
	s.t.Helper()
	s.t.Log("verify failed nontransactional ClickHouse migration leaves partial DDL without advancing Goose")
	provider, err := goose.NewProvider(goose.DialectClickHouse, ch,
		os.DirFS(filepath.Join(s.root, "tests/integration/testdata/clickhouse-failure")),
		goose.WithTableName("validation_failed_goose_versions"))
	s.must("create failure-proof Goose provider", err)
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	defer cancel()
	if _, err := provider.Up(ctx); err == nil {
		s.t.Fatal("deliberately invalid ClickHouse migration succeeded")
	}
	version, err := provider.GetDBVersion(ctx)
	s.must("read failed Goose migration version", err)
	if version != 0 {
		s.t.Fatalf("failed migration advanced Goose version to %d", version)
	}
	var tables uint64
	s.must("inspect partial ClickHouse DDL", ch.QueryRowContext(ctx, "SELECT count() FROM system.tables WHERE database = 'logice' AND name = 'validation_partial_ddl'").Scan(&tables))
	if tables != 1 {
		s.t.Fatal("expected nontransactional migration to leave its successful DDL")
	}
	// A retry is not automatically safe: the unversioned table already exists.
	if _, err := provider.Up(ctx); err == nil {
		s.t.Fatal("non-idempotent partial DDL unexpectedly succeeded on retry")
	}
	_, err = ch.ExecContext(ctx, "DROP TABLE validation_partial_ddl")
	s.must("remove partial DDL proof fixture", err)
}
