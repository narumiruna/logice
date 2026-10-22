//go:build integration

package integration

import (
	"encoding/hex"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"testing"
)

func TestLiveFeasibility(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	f := newTelemetry(t)
	s.exportHTTP("/v1/traces", traceRequest(f.span("live-proof", f.parentID, nil)), &collectortrace.ExportTraceServiceResponse{})
	s.exportHTTP("/v1/logs", f.logRequest(), &collectorlog.ExportLogsServiceResponse{})
	s.waitCount(db, "otel_traces", hex.EncodeToString(f.traceID), 1)
	s.waitCount(db, "otel_logs", hex.EncodeToString(f.traceID), 1)
	var version string
	s.must("version", db.QueryRowContext(s.ctx, "SELECT version()").Scan(&version))
	t.Log("ClickHouse", version)
	for _, table := range []string{"otel_traces", "otel_logs"} {
		rows, err := db.QueryContext(s.ctx, "SELECT name,type FROM system.columns WHERE database='logice' AND table=? ORDER BY position", table)
		s.must("columns", err)
		columns := 0
		for rows.Next() {
			columns++
			var name, typ string
			s.must("column", rows.Scan(&name, &typ))
			t.Log(table, name, typ)
		}
		s.must("columns end", rows.Err())
		_ = rows.Close()
		expected := 22
		if table == "otel_logs" {
			expected = 24
		}
		if columns != expected {
			t.Fatalf("pinned %s schema changed: got %d stored columns, expected %d; review Live canonical inventory", table, columns, expected)
		}
	}
	var payload string
	s.must("canonical sorted map tuple", db.QueryRowContext(s.ctx, `SELECT toJSONString(tuple(toString(toUnixTimestamp64Nano(Timestamp)), TraceId, SpanId, arraySort(x -> tuple(x.1,x.2), arrayZip(mapKeys(LogAttributes),mapValues(LogAttributes))))) FROM logice.otel_logs LIMIT 1`).Scan(&payload))
	var n uint64
	s.must("group before limit", db.QueryRowContext(s.ctx, `SELECT count() FROM (SELECT TraceId,SpanId,min(SpanName),count() FROM logice.otel_traces GROUP BY TraceId,SpanId LIMIT 501)`).Scan(&n))
	s.must("integer histogram", db.QueryRowContext(s.ctx, `SELECT toUInt64(intDiv((toInt128(toUnixTimestamp64Nano(Timestamp)) - toInt128(?))*60,toInt128(?))) FROM logice.otel_traces LIMIT 1`, f.start.UnixNano(), int64(1000000001)).Scan(&n))
	if n != 0 {
		t.Fatal("incorrect bucket", n)
	}
	t.Log("Canonical tuple/map JSON, grouping-before-limit, Int128 nanosecond histogram proved")
}
