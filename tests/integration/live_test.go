//go:build integration

package integration

import (
	"encoding/hex"
	query "github.com/narumiruna/logice/internal/telemetry"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"testing"
	"time"
)

func TestLiveIngestion(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("open Live store", err)
	t.Cleanup(func() { _ = store.Close() })
	f := newTelemetry(t)
	filter := query.LiveFilter{From: f.start.Add(-time.Second), To: f.start.Add(time.Second)}
	empty, err := store.Live(s.ctx, filter)
	s.must("empty Live", err)
	if len(empty.Histogram) != 60 || len(empty.Spans) != 0 || len(empty.Logs) != 0 {
		t.Fatal("bad empty snapshot")
	}
	s.exportHTTP("/v1/traces", traceRequest(f.span("parent", f.parentID, nil), f.span("child", f.childID, f.parentID)), &collectortrace.ExportTraceServiceResponse{})
	id := hex.EncodeToString(f.traceID)
	s.waitCount(db, "otel_traces", id, 2)
	oneTable, err := store.Live(s.ctx, filter)
	s.must("Live with only the span table", err)
	if len(oneTable.Spans) != 2 || len(oneTable.Logs) != 0 {
		t.Fatal("one missing table erased available spans")
	}
	s.exportHTTP("/v1/logs", f.logRequest(), &collectorlog.ExportLogsServiceResponse{})
	s.waitCount(db, "otel_logs", id, 1)
	result, err := store.Live(s.ctx, filter)
	s.must("real Live snapshot", err)
	if len(result.Spans) != 2 || len(result.Logs) != 1 {
		t.Fatalf("unexpected live sizes %d %d", len(result.Spans), len(result.Logs))
	}
	filter.Search = "CHILD"
	result, err = store.Live(s.ctx, filter)
	s.must("real Live context", err)
	if len(result.Spans) != 1 || len(result.Context) != 1 || result.Context[0].Name != "parent" {
		t.Fatalf("unexpected context sizes %d %d", len(result.Spans), len(result.Context))
	}
}
