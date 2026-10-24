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
	// Keep semantic fixtures separate from the load fixture. Boundaries are
	// nanosecond-precise even though the response has only sixty buckets.
	start := f.start.UnixNano()
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces(Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes,Duration,StatusCode) VALUES
	 (fromUnixTimestamp64Nano(?),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaa','','first','overview-semantics',map('logice.project.id',?),0,'Unset'),
	 (fromUnixTimestamp64Nano(?),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaa','','conflict','overview-semantics',map('logice.project.id',?),100,'Unset'),
	 (fromUnixTimestamp64Nano(?),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb','','second-root','overview-semantics',map('logice.project.id',?),100,'Error'),
	 (fromUnixTimestamp64Nano(?),'invalid','invalid','','malformed','overview-semantics',map('logice.project.id',?),900,'Error'),
	 (fromUnixTimestamp64Nano(?),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccc','','at-end','overview-semantics',map('logice.project.id',?),1000,'Error'),
	 (fromUnixTimestamp64Nano(?),'cccccccccccccccccccccccccccccccc','dddddddddddddddd','','before-start','overview-semantics',map('logice.project.id',?),1000,'Error')`, start, fixtureProject, start, fixtureProject, start+1, fixtureProject, start+2, fixtureProject, start+int64(time.Second), fixtureProject, start-1, fixtureProject)
	s.must("seed semantic fixtures", err)
	filter = query.Filter{From: f.start, To: f.start.Add(time.Second), Service: "overview-semantics"}
	semantics := read()
	if semantics.Spans != "3" || semantics.Traces != "1" || semantics.ErrorTraces != "1" || semantics.RootSpans != "1" || semantics.Conflicts != "1" || semantics.P95NS == nil || *semantics.P95NS != "100" {
		t.Fatal("conflicts, malformed IDs, roots, or half-open bounds changed", semantics.OverviewStats)
	}
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces(Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes,Duration) VALUES(fromUnixTimestamp64Nano(?),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','eeeeeeeeeeeeeeee','','late-root','overview-semantics',map('logice.project.id',?),300)`, start+int64(time.Second)-1, fixtureProject)
	s.must("seed late arrival", err)
	late := read()
	if late.Spans != "4" || late.Traces != "1" || late.RootSpans != "2" || late.P95NS == nil || *late.P95NS != "300" {
		t.Fatal("late arrival or multiple roots were not included", late.OverviewStats)
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
