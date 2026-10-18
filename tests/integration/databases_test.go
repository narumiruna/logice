//go:build integration

package integration

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func (s *stack) databases() (*sql.DB, *sql.DB) {
	s.t.Helper()
	host, portText, err := net.SplitHostPort(s.ports["postgres"])
	s.must("parse PostgreSQL address", err)
	port, err := strconv.ParseUint(portText, 10, 16)
	s.must("parse PostgreSQL port", err)
	// Construct connection settings without a secret-bearing DSN in an error.
	pgConfig, err := pgx.ParseConfig("host=127.0.0.1 port=5432 user=logice dbname=logice sslmode=disable")
	s.must("create PostgreSQL configuration", err)
	pgConfig.Host, pgConfig.Port = host, uint16(port)
	pgConfig.User, pgConfig.Database, pgConfig.Password = "logice", "logice", s.secrets[0]
	pgConfig.TLSConfig, pgConfig.Fallbacks = nil, nil
	pgConfig.ConnectTimeout = 5 * time.Second
	pg := stdlib.OpenDB(*pgConfig)
	ch := clickhouse.OpenDB(&clickhouse.Options{
		Addr:        []string{s.ports["clickhouse"]},
		Auth:        clickhouse.Auth{Database: "logice", Username: "logice", Password: s.secrets[1]},
		DialTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second,
		Settings: clickhouse.Settings{"max_execution_time": 5},
	})
	for _, db := range []*sql.DB{pg, ch} {
		db.SetMaxOpenConns(3)
		db.SetMaxIdleConns(1)
		s.t.Cleanup(func() { _ = db.Close() })
	}
	s.eventually("PostgreSQL native connection", 45*time.Second, pg.PingContext)
	s.eventually("ClickHouse native connection", 45*time.Second, ch.PingContext)
	return pg, ch
}

func (s *stack) must(label string, err error) {
	s.t.Helper()
	if err != nil {
		s.t.Fatalf("%s: %s", label, s.redact(err.Error()))
	}
}

func (s *stack) migrations(pg, ch *sql.DB) {
	s.t.Helper()
	s.t.Log("apply each Goose migration twice and check version tracking")
	for _, target := range []struct {
		name    string
		dialect goose.Dialect
		db      *sql.DB
	}{{"postgres", goose.DialectPostgres, pg}, {"clickhouse", goose.DialectClickHouse, ch}} {
		provider, err := goose.NewProvider(target.dialect, target.db, os.DirFS(filepath.Join(s.root, "tests/integration/testdata", target.name)))
		s.must("create "+target.name+" Goose provider", err)
		ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
		first, err := provider.Up(ctx)
		s.must("first "+target.name+" migration", err)
		second, err := provider.Up(ctx)
		s.must("second "+target.name+" migration", err)
		version, err := provider.GetDBVersion(ctx)
		s.must("read "+target.name+" Goose version", err)
		cancel()
		if len(first) != 1 || len(second) != 0 || version != 1 {
			s.t.Fatalf("%s migration tracking: first=%d second=%d version=%d", target.name, len(first), len(second), version)
		}
	}
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	_, err := pg.ExecContext(ctx, "INSERT INTO validation_projects (id, display_name) VALUES ($1, $2)", "validation", "Stack validation")
	s.must("insert PostgreSQL application metadata", err)
	_, err = ch.ExecContext(ctx, "INSERT INTO validation_migration_proof (id, value) VALUES (?, ?)", uint64(1), "persistent")
	s.must("insert ClickHouse migration proof", err)
	s.checkPersistence(pg, ch)
}

func (s *stack) checkPersistence(pg, ch *sql.DB) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	var name, value string
	s.must("read PostgreSQL application metadata", pg.QueryRowContext(ctx, "SELECT display_name FROM validation_projects WHERE id = $1", "validation").Scan(&name))
	s.must("read ClickHouse migration proof", ch.QueryRowContext(ctx, "SELECT value FROM validation_migration_proof WHERE id = ?", uint64(1)).Scan(&value))
	if name != "Stack validation" || value != "persistent" {
		s.t.Fatal("database values did not persist")
	}
	// PostgreSQL contains only the application fixture and Goose bookkeeping.
	var tables int
	s.must("check PostgreSQL metadata-only schema", pg.QueryRowContext(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'").Scan(&tables))
	if tables != 2 {
		s.t.Fatalf("expected application metadata and Goose tables only, got %d", tables)
	}
}

func (s *stack) count(db *sql.DB, table, traceID string) (uint64, error) {
	// Table names are test constants, not request input.
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	var count uint64
	query := fmt.Sprintf("SELECT count() FROM logice.%s", table)
	var args []any
	if traceID != "" {
		query += " WHERE TraceId = ?"
		args = append(args, traceID)
	}
	err := db.QueryRowContext(ctx, query, args...).Scan(&count)
	return count, err
}
