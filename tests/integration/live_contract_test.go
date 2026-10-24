//go:build integration

package integration

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/narumiruna/logice/internal/httpapi"
	query "github.com/narumiruna/logice/internal/telemetry"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
)

func TestLiveContractAndLimits(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	f := newTelemetry(t)
	s.exportHTTP("/v1/traces", traceRequest(f.span("root", f.parentID, nil), f.span("child", f.childID, f.parentID)), &collectortrace.ExportTraceServiceResponse{})
	s.exportHTTP("/v1/logs", f.logRequest(), &collectorlog.ExportLogsServiceResponse{})
	traceID := hex.EncodeToString(f.traceID)
	spanID := hex.EncodeToString(f.childID)
	s.waitCount(db, "otel_traces", traceID, 2)
	s.waitCount(db, "otel_logs", traceID, 1)
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("open store", err)
	t.Cleanup(func() { _ = store.Close() })
	filter := query.LiveFilter{From: f.start.Add(-time.Second), To: f.start.Add(time.Second)}
	exec := func(statement string, args ...any) {
		t.Helper()
		_, err := db.ExecContext(s.ctx, statement, args...)
		s.must("insert Live fixture", err)
	}
	read := func(f query.LiveFilter) query.LiveSnapshot {
		t.Helper()
		r, err := store.Live(s.ctx, f)
		s.must("read Live snapshot", err)
		return r
	}
	t.Run("canonical full metadata conflicts and isolation", func(t *testing.T) {
		// Identical content with a different map entry order remains one log group.
		exec(`INSERT INTO logice.otel_logs SELECT * REPLACE (mapFromArrays(arrayReverse(mapKeys(LogAttributes)),arrayReverse(mapValues(LogAttributes))) AS LogAttributes) FROM logice.otel_logs WHERE TraceId=?`, traceID)
		// Scope-only, schema, event, and flag changes each produce a distinct ID.
		for _, replacement := range []string{"'different' AS ScopeName", "'different' AS ScopeVersion", "map('x','y') AS ScopeAttributes", "'different' AS ScopeSchemaUrl", "'different' AS ResourceSchemaUrl", "'different' AS EventName", "toUInt8(2) AS TraceFlags"} {
			exec(`INSERT INTO logice.otel_logs SELECT * REPLACE (`+replacement+`) FROM logice.otel_logs WHERE TraceId=? LIMIT 1`, traceID)
		}
		exec(`INSERT INTO logice.otel_traces SELECT * FROM logice.otel_traces WHERE TraceId=? AND SpanId=?`, traceID, spanID)
		exec(`INSERT INTO logice.otel_traces SELECT * REPLACE ('not matching' AS SpanName,'1111111111111111' AS ParentSpanId,'Error' AS StatusCode) FROM logice.otel_traces WHERE TraceId=? AND SpanId=? LIMIT 1`, traceID, spanID)
		for _, table := range []string{"otel_traces", "otel_logs"} {
			exec(`INSERT INTO logice.`+table+` SELECT * REPLACE (map('logice.project.id','foreign') AS ResourceAttributes) FROM logice.`+table+` WHERE TraceId=?`, traceID)
		}
		matching := filter
		matching.Search = "CHILD"
		r := read(matching)
		if len(r.Spans) != 1 || r.Spans[0].Name != "child" || !r.Spans[0].Conflict || !r.Spans[0].ParentConflict || r.Spans[0].Occurrences != "3" || len(r.Context) != 0 {
			t.Fatal("conflicting span failed matching representative/total occurrences/parent ambiguity")
		}
		if liveCount(r.Histogram, false, false) != 2 {
			t.Fatal("histogram must count matching physical rows, not total variants")
		}
		r = read(filter)
		if len(r.Logs) != 8 {
			t.Fatalf("scope metadata identity lost: %d", len(r.Logs))
		}
		occurrences := 0
		seen := map[string]bool{}
		for _, record := range r.Logs {
			if seen[record.ID] {
				t.Fatal("duplicate identity")
			}
			seen[record.ID] = true
			n, _ := strconv.Atoi(record.Occurrences)
			occurrences += n
			if len(record.Stored) != 24 {
				t.Fatal("not every stored log column projected")
			}
		}
		if occurrences != 9 || liveCount(r.Histogram, true, false) != 9 {
			t.Fatal("identical log occurrences or project scope")
		}
		before, _ := json.Marshal(r.Logs)
		after, _ := json.Marshal(read(filter).Logs)
		if string(before) != string(after) {
			t.Fatal("unstable repeated snapshot")
		}
		// Malformed pairs never acquire a trace/span identity; payload changes survive.
		exec(`INSERT INTO logice.otel_traces SELECT * REPLACE ('bad' AS SpanId,'malformed' AS SpanName) FROM logice.otel_traces WHERE TraceId=? LIMIT 1`, traceID)
		exec(`INSERT INTO logice.otel_traces SELECT * REPLACE ('bad' AS SpanId,'malformed other' AS SpanName) FROM logice.otel_traces WHERE TraceId=? LIMIT 1`, traceID)
		malformed := filter
		malformed.Search = "malformed"
		r = read(malformed)
		if len(r.Spans) != 2 || r.Spans[0].ID == r.Spans[1].ID || !strings.HasPrefix(r.Spans[0].ID, "span-content:v1:") {
			t.Fatal("malformed content identity")
		}
	})
	t.Run("canonical minimum matching independent of insertion order", func(t *testing.T) {
		id := randomHex(t, 16)
		for _, name := range []string{"z matching", "a excluded", "b matching"} {
			exec(`INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),?,'1111111111111111',?,'canonical',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, f.start.UnixNano(), id, name)
		}
		selected := filter
		selected.Search = "matching"
		selected.Service = "canonical"
		r := read(selected)
		if len(r.Spans) != 1 || r.Spans[0].Name != "b matching" || r.Spans[0].Occurrences != "3" || !r.Spans[0].Conflict {
			t.Fatal("not canonical minimum matching")
		}
		for _, name := range []string{"b matching", "a excluded", "z matching"} {
			exec(`INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),?,'1111111111111111',?,'canonical',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, f.start.UnixNano(), id, name)
		}
		r = read(selected)
		if len(r.Spans) != 1 || r.Spans[0].Name != "b matching" || r.Spans[0].Occurrences != "6" {
			t.Fatal("insertion order changed representative")
		}
	})
	t.Run("delimiter maps and raw severity", func(t *testing.T) {
		for _, attrs := range []string{`map('a|b','c','a','b|c')`, `map('a','b|c','a|b','c')`, `map('a|b','c|d')`, `map('a','b|c|d')`} {
			exec(`INSERT INTO logice.otel_logs (Timestamp,Body,ServiceName,SeverityNumber,LogAttributes,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),'a|b:c<>','delimiter',255,`+attrs+`,map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, f.start.UnixNano())
		}
		selected := filter
		selected.Service = "delimiter"
		r := read(selected)
		if len(r.Logs) != 3 || liveCount(r.Histogram, true, true) != 4 {
			t.Fatal("delimiter-like maps merged distinct content")
		}
		for _, record := range r.Logs {
			if record.SeverityNumber != 255 {
				t.Fatal("raw stored severity was clipped")
			}
		}
	})
	t.Run("exact uneven nanosecond histogram", func(t *testing.T) {
		start := f.start.Add(-time.Second)
		width := int64(1000000001)
		id := randomHex(t, 16)
		for i := int64(0); i <= 60; i++ {
			exec(`INSERT INTO logice.otel_logs (Timestamp,TraceId,Body,ServiceName,SeverityNumber,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),?,'boundary','boundaries',17,map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, start.UnixNano()+i*width/60, id)
		}
		selected := query.LiveFilter{From: start, To: start.Add(time.Duration(width)), Service: "boundaries", Search: "BOUNDARY", ErrorsOnly: true, MinSeverity: 9}
		r := read(selected)
		if len(r.Logs) != 60 || liveCount(r.Histogram, true, true) != 60 {
			t.Fatal("physical boundary totals")
		}
		for _, b := range r.Histogram {
			if b.Logs != "1" || b.ErrorLogs != "1" {
				t.Fatalf("uneven boundary wrongly assigned %s %s", b.Logs, b.ErrorLogs)
			}
		}
	})
	t.Run("independent grouped feed caps before limit", func(t *testing.T) {
		id := randomHex(t, 16)
		exec(`INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?),?,leftPad(hex(number+1),16,'0'),'cap','caps',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(501)`, f.start.UnixNano(), id)
		exec(`INSERT INTO logice.otel_logs (Timestamp,TraceId,Body,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?),?,toString(number),'caps',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(501)`, f.start.UnixNano(), id)
		for _, table := range []string{"otel_traces", "otel_logs"} {
			exec(`INSERT INTO logice.`+table+` SELECT * FROM logice.`+table+` WHERE TraceId=? LIMIT 101`, id)
		}
		selected := filter
		selected.Service = "caps"
		r := read(selected)
		if len(r.Spans) != 500 || len(r.Logs) != 500 || !r.SpansTruncated || !r.LogsTruncated || liveCount(r.Histogram, false, false) != 602 || liveCount(r.Histogram, true, false) != 602 {
			t.Fatal("group before independent cap/count physical rows")
		}
	})
	t.Run("fair context no recursive queries", func(t *testing.T) {
		wide, small := randomHex(t, 16), randomHex(t, 16)
		exec(`INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?),?,leftPad(hex(number+1),16,'0'),if(number=0,'',leftPad(hex(number),16,'0')),'ancestor','context',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(1000)`, f.start.UnixNano(), wide)
		for _, spec := range []struct{ id, span, parent, name string }{{wide, "0000000000001000", "00000000000003E8", "needle"}, {small, "1111111111111111", "", "ancestor"}, {small, "2222222222222222", "1111111111111111", "needle"}} {
			exec(`INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),?,?,?,?,'context',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, f.start.UnixNano(), spec.id, spec.span, spec.parent, spec.name)
		}
		selected := filter
		selected.Service = "context"
		selected.Search = "needle"
		r := read(selected)
		found := map[string]bool{}
		for _, record := range r.Context {
			found[record.TraceID] = true
			if !record.ContextOnly {
				t.Fatal("context role missing")
			}
		}
		if len(r.Spans) != 2 || !r.ContextTruncated || !found[wide] || !found[small] || len(r.Context) > 500 {
			t.Fatal("wide trace starved another trace")
		}
	})
	t.Run("real resource bounds and cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(s.ctx)
		cancel()
		if _, err := store.Live(ctx, filter); err == nil {
			t.Fatal("canceled query succeeded")
		}
		// Real grouping exceeds a deliberately small memory budget; the failure must
		// remain an error, not a missing-table empty result or a skipped component.
		limited := clickhouse.Context(s.ctx, clickhouse.WithSettings(clickhouse.Settings{"max_memory_usage": 1024, "max_execution_time": 1, "readonly": 1}))
		var n uint64
		err := db.QueryRowContext(limited, `SELECT uniqExact(toString(number)) FROM numbers(1000000)`).Scan(&n)
		if err == nil {
			t.Fatal("real grouping ignored resource limit")
		}
		timed, stop := context.WithTimeout(s.ctx, 25*time.Millisecond)
		started := time.Now()
		err = db.QueryRowContext(timed, `SELECT sleep(0.5)`).Scan(&n)
		stop()
		if err == nil || time.Since(started) > time.Second {
			t.Fatal("real query cancellation did not bound work")
		}
	})
	t.Run("deterministic 10k performance HTTP", func(t *testing.T) {
		liveSeed10k(t, s, db, f.start)
		server := httptest.NewServer(scopedHandler(httpapi.NewServer(store).Handler))
		defer server.Close()
		params := url.Values{"from": {filter.From.Format(time.RFC3339Nano)}, "to": {filter.To.Format(time.RFC3339Nano)}, "service": {"performance"}}
		endpoint := server.URL + "/api/live?" + params.Encode()
		samples := make([]time.Duration, 0, 30)
		sizes := []int{}
		for i := 0; i < 32; i++ {
			started := time.Now()
			req, err := http.NewRequestWithContext(s.ctx, "GET", endpoint, nil)
			s.must("performance request", err)
			response, err := s.http.Do(req)
			s.must("performance response", err)
			body, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
			_ = response.Body.Close()
			s.must("performance read", err)
			elapsed := time.Since(started)
			if response.StatusCode != 200 {
				t.Fatalf("performance status %d", response.StatusCode)
			}
			var r query.LiveSnapshot
			s.must("performance decode", json.Unmarshal(body, &r))
			if len(r.Spans)+len(r.Logs)+len(r.Context) > 1500 || !r.SpansTruncated || !r.LogsTruncated || !r.TraceGroupsTruncated || liveCount(r.Histogram, false, false) != 5000 || liveCount(r.Histogram, true, false) != 5000 {
				t.Fatal("10k fixture limits/counts")
			}
			if i >= 2 {
				samples = append(samples, elapsed)
				sizes = append(sizes, len(body))
			}
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		sort.Ints(sizes)
		p95 := samples[28]
		var version string
		s.must("version", db.QueryRowContext(s.ctx, "SELECT version()").Scan(&version))
		t.Logf("local result: OS=%s arch=%s CPUs=%d Go=%s ClickHouse=%s records=10000 warmup=2 samples=30 HTTP p50=%s p95=%s max=%s payload=%d..%d bytes", runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.Version(), version, samples[14], p95, samples[29], sizes[0], sizes[29])
		if p95 > 2*time.Second || samples[29] > 5*time.Second {
			t.Fatal("local performance target missed")
		}
	})
	t.Run("actual Live resource settings and cancellation", func(t *testing.T) { liveNativeSettingsAndCancellation(t, s, db, f.start) })
	t.Run("native case identity and epoch-zero rank", func(t *testing.T) { liveNativeEpochAndCase(t, s, db, store, f.start) })
	t.Run("oversized API error and outage health", func(t *testing.T) {
		exec(`INSERT INTO logice.otel_logs (Timestamp,Body,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),repeat('xxxxx',440000),'oversized',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, f.start.UnixNano())
		server := httptest.NewServer(scopedHandler(httpapi.NewServer(store).Handler))
		defer server.Close()
		params := url.Values{"from": {filter.From.Format(time.RFC3339Nano)}, "to": {filter.To.Format(time.RFC3339Nano)}, "service": {"oversized"}}
		response, err := s.http.Get(server.URL + "/api/live?" + params.Encode())
		s.must("oversized API", err)
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		s.must("read oversized", err)
		if response.StatusCode != 422 || !strings.Contains(string(body), "response_too_large") || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("oversized response status %d", response.StatusCode)
		}
		s.run("stop", "--timeout", "3", "clickhouse")
		outageCtx, stop := context.WithTimeout(s.ctx, time.Second)
		_, outageErr := store.Live(outageCtx, filter)
		stop()
		if outageErr == nil {
			t.Fatal("real ClickHouse outage returned an empty success")
		}
		health, err := s.http.Get(server.URL + "/api/healthz")
		s.must("liveness during real outage", err)
		_ = health.Body.Close()
		if health.StatusCode != 200 {
			t.Fatal("real outage failed API liveness")
		}
		s.run("start", "clickhouse")
		s.refreshPorts()
		recovered, err := query.Open(s.ports["clickhouse"], s.secrets[1])
		s.must("open recovered store", err)
		defer recovered.Close()
		s.eventually("Live after real outage", 30*time.Second, func(ctx context.Context) error {
			r, err := recovered.Live(ctx, query.LiveFilter{From: filter.From, To: filter.To, Service: "caps"})
			if err == nil && (len(r.Spans) != 500 || len(r.Logs) != 500) {
				return errors.New("recovered Live lost stored records")
			}
			return err
		})
		s.must("close storage", store.Close())
		for _, tc := range []struct {
			path   string
			status int
		}{{"/api/live", 503}, {"/api/healthz", 200}} {
			response, err := s.http.Get(server.URL + tc.path)
			s.must("outage API", err)
			_ = response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatal("storage outage/liveness")
			}
		}
	})
}

func liveCount(buckets []query.LiveBucket, logs, errorsOnly bool) uint64 {
	var total uint64
	for _, b := range buckets {
		value := b.Spans
		if logs {
			value = b.Logs
		}
		if errorsOnly {
			value = b.ErrorSpans
			if logs {
				value = b.ErrorLogs
			}
		}
		n, _ := strconv.ParseUint(value, 10, 64)
		total += n
	}
	return total
}

func liveSeed10k(t *testing.T, s *stack, db *sql.DB, start time.Time) {
	t.Helper()
	// 5,000 spans: a 1,000-deep chain, a wide trace, and 198 other traces.
	_, err := db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,Duration,StatusCode,ResourceAttributes)
 SELECT fromUnixTimestamp64Nano(?+toInt64(number)),leftPad(hex(if(number<1000,1,if(number<2000,2,3+number%198))),32,'0'),leftPad(hex(number+1),16,'0'),if(number>0 AND number<1000,leftPad(hex(number),16,'0'),''),concat('span-',toString(number)),'performance',toUInt64(1000),if(number%10=0,'Error','Ok'),map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(5000)`, start.UnixNano())
	s.must("seed 5000 spans", err)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_logs (Timestamp,TraceId,SpanId,Body,ServiceName,SeverityNumber,ResourceAttributes)
 SELECT fromUnixTimestamp64Nano(?+toInt64(number)),if(number%5=0,'',leftPad(hex(1+number%200),32,'0')),'',concat('log-',toString(number)),'performance',toUInt8(if(number%10=0,17,9)),map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(5000)`, start.UnixNano())
	s.must("seed 5000 logs", err)
}
