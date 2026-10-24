//go:build integration

package integration

import (
	"context"
	"encoding/hex"
	"testing"
	"time"

	query "github.com/narumiruna/logice/internal/telemetry"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestOverviewAggregates(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	f := newTelemetry(t)
	root := f.span("overview-root", f.parentID, nil)
	child := f.span("overview-child", f.childID, f.parentID)
	child.Status = &trace.Status{Code: trace.Status_STATUS_CODE_ERROR}
	s.exportHTTP("/v1/traces", traceRequest(root, child), &collectortrace.ExportTraceServiceResponse{})
	s.exportHTTP("/v1/logs", f.logRequest(), &collectorlog.ExportLogsServiceResponse{})
	id := hex.EncodeToString(f.traceID)
	s.waitCount(db, "otel_traces", id, 2)
	s.waitCount(db, "otel_logs", id, 1)
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("open overview", err)
	defer store.Close()
	ctx := query.WithProject(s.ctx, fixtureProject)
	filter := query.Filter{From: f.start.Add(-time.Second), To: f.start.Add(time.Second)}
	read := func() query.Overview {
		t.Helper()
		r, err := store.Overview(ctx, filter)
		s.must("overview", err)
		return r
	}
	first := read()
	if first.Traces != "1" || first.ErrorTraces != "1" || first.Logs != "1" || first.RootSpans != "1" || first.P95NS == nil || first.ErrorProportion == nil || *first.ErrorProportion != 1 || len(first.Buckets) != 60 {
		t.Fatalf("unexpected aggregate counts: %+v", first.OverviewStats)
	}
	for _, table := range []string{"otel_traces", "otel_logs"} {
		_, err = db.ExecContext(s.ctx, `INSERT INTO logice.`+table+` SELECT * FROM logice.`+table+` WHERE TraceId=?`, id)
		s.must("duplicate fixture", err)
		_, err = db.ExecContext(s.ctx, `INSERT INTO logice.`+table+` SELECT * REPLACE(map('logice.project.id','foreign') AS ResourceAttributes) FROM logice.`+table+` WHERE TraceId=?`, id)
		s.must("foreign duplicate IDs", err)
	}
	second := read()
	if second.Traces != first.Traces || second.Logs != first.Logs || second.RootSpans != first.RootSpans {
		t.Fatal("duplicates or cross-project data inflated totals")
	}
	for i, bucket := range second.Buckets {
		if !bucket.From.Before(bucket.To) || (i > 0 && !bucket.From.Equal(second.Buckets[i-1].To)) {
			t.Fatal("bucket gap")
		}
	}
	filter.Service = "absent"
	empty := read()
	if empty.Traces != "0" || empty.Logs != "0" || empty.P95NS != nil || empty.ErrorProportion != nil {
		t.Fatal("empty population fabricated statistics")
	}
	overviewResources(t, s, db, store, f.start)
	if _, err := store.Overview(context.Background(), filter); err == nil {
		t.Fatal("missing scope accepted")
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.Overview(cancelCtx, filter); err == nil {
		t.Fatal("canceled query accepted")
	}
}
