//go:build integration

package integration

import (
	"context"
	"database/sql"
	"regexp"
	"time"
)

func (s *stack) verifyExporterSchema(db *sql.DB) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	ttl := regexp.MustCompile(`TTL (?:toDateTime\(Timestamp\)|Timestamp) \+ toInterval(?:Second\(86400\)|Hour\(24\)|Day\(1\))`)
	for table, attributes := range map[string]string{"otel_traces": "SpanAttributes", "otel_logs": "LogAttributes"} {
		for _, column := range []string{"ResourceAttributes", attributes} {
			var dataType string
			s.must("inspect exporter attribute schema", db.QueryRowContext(ctx, "SELECT type FROM system.columns WHERE database = 'logice' AND table = ? AND name = ?", table, column).Scan(&dataType))
			if dataType != "Map(LowCardinality(String), String)" {
				s.t.Fatalf("%s.%s type is %s, expected Map(LowCardinality(String), String)", table, column, dataType)
			}
		}
		var ddl string
		s.must("inspect exporter retention schema", db.QueryRowContext(ctx, "SELECT create_table_query FROM system.tables WHERE database = 'logice' AND name = ?", table).Scan(&ddl))
		if !ttl.MatchString(ddl) {
			s.t.Fatalf("%s does not have the expected 24-hour Timestamp TTL: %s", table, ddl)
		}
	}
}
