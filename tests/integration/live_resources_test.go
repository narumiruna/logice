//go:build integration

package integration

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	query "github.com/narumiruna/logice/internal/telemetry"
)

func liveNativeSettingsAndCancellation(t *testing.T, s *stack, db *sql.DB, start time.Time) {
	t.Helper()
	loggedDB := clickhouse.OpenDB(&clickhouse.Options{Addr: []string{s.ports["clickhouse"]}, Auth: clickhouse.Auth{Database: "logice", Username: "logice", Password: s.secrets[1]}, DialTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, Settings: clickhouse.Settings{"log_queries": 1, "log_query_settings": 1}})
	loggedDB.SetMaxOpenConns(1)
	store := query.NewStore(loggedDB)
	defer store.Close()
	var seeded uint64
	s.must("check independent resource fixture", db.QueryRowContext(s.ctx, "SELECT count() FROM logice.otel_traces WHERE ServiceName='performance'").Scan(&seeded))
	if seeded == 0 {
		liveSeed10k(t, s, db, start)
	}
	filter := query.LiveFilter{From: start.Add(-time.Second), To: start.Add(time.Second), Service: "performance"}
	id := "live-settings-" + randomHex(t, 8)
	_, err := store.Live(clickhouse.Context(s.ctx, clickhouse.WithQueryID(id)), filter)
	s.must("actual Live with settings evidence", err)
	_, err = db.ExecContext(s.ctx, "SYSTEM FLUSH LOGS")
	s.must("flush disposable query settings evidence", err)
	var total, bounded uint64
	s.must("inspect actual Live query settings", db.QueryRowContext(s.ctx, `SELECT count(), countIf(Settings['readonly']='1' AND Settings['max_execution_time']='5' AND Settings['max_memory_usage']='134217728' AND Settings['max_result_bytes']='8388608' AND Settings['result_overflow_mode'] IN ('','throw') AND Settings['timeout_overflow_mode'] IN ('','throw')) FROM system.query_log WHERE query_id=? AND type='QueryFinish'`, id).Scan(&total, &bounded))
	if total != 5 || bounded != 5 {
		var readonly, execution, memory, result, overflow, timeout string
		s.must("inspect fixed safe settings", db.QueryRowContext(s.ctx, `SELECT Settings['readonly'],Settings['max_execution_time'],Settings['max_memory_usage'],Settings['max_result_bytes'],Settings['result_overflow_mode'],Settings['timeout_overflow_mode'] FROM system.query_log WHERE query_id=? AND type='QueryFinish' LIMIT 1`, id).Scan(&readonly, &execution, &memory, &result, &overflow, &timeout))
		t.Fatalf("actual Live settings not applied: total=%d bounded=%d readonly=%q execution=%q memory=%q result=%q overflow=%q timeout=%q", total, bounded, readonly, execution, memory, result, overflow, timeout)
	}
	// query_log omits unchanged default settings. Verify their effective values.
	var throwDefaults uint64
	s.must("inspect overflow defaults", db.QueryRowContext(s.ctx, `SELECT count() FROM system.settings WHERE name IN ('result_overflow_mode','timeout_overflow_mode') AND value='throw'`).Scan(&throwDefaults))
	if throwDefaults != 2 {
		t.Fatal("overflow defaults are not throw")
	}
	// The heavy fixture uses a separate window, so it cannot affect other reads.
	heavy := start.Add(time.Minute)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?),'dddddddddddddddddddddddddddddddd',leftPad(hex(number+1),16,'0'),concat('heavy-',toString(number)),'heavy',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(500000)`, heavy.UnixNano())
	s.must("seed actual Live memory fixture", err)
	filter = query.LiveFilter{From: heavy.Add(-time.Second), To: heavy.Add(time.Second), Service: "heavy"}
	ctx, cancel := context.WithTimeout(s.ctx, 3*time.Second)
	defer cancel()
	var progressed atomic.Bool
	ctx = clickhouse.Context(ctx, clickhouse.WithProgress(func(*clickhouse.Progress) { progressed.Store(true); cancel() }))
	started := time.Now()
	_, err = store.Live(ctx, filter)
	if err == nil || !progressed.Load() || time.Since(started) > time.Second {
		t.Fatalf("active native Live cancellation failed: progress=%v elapsed=%s", progressed.Load(), time.Since(started))
	}
	_, err = store.Live(s.ctx, filter)
	var exception *clickhouse.Exception
	if !errors.As(err, &exception) || exception.Code != 241 {
		t.Fatal("actual Live grouping did not enforce its 128 MiB memory limit")
	}
	t.Log("Actual five Live reads have readonly=1, max_execution_time=5, memory=128MiB, result=8MiB, throw overflow; active Live canceled on server progress; heavy Live fails with MEMORY_LIMIT_EXCEEDED")
}

func liveNativeEpochAndCase(t *testing.T, s *stack, db *sql.DB, store *query.Store, start time.Time) {
	t.Helper()
	for _, upper := range []bool{false, true} {
		trace, span, parent := strings.Repeat("a", 32), strings.Repeat("b", 16), strings.Repeat("c", 16)
		if upper {
			trace = strings.ToUpper(trace)
			span = strings.ToUpper(span)
			parent = strings.ToUpper(parent)
		}
		_, err := db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),?,?,?,'case','case',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, start.UnixNano(), trace, span, parent)
		s.must("insert case-normalized identity", err)
	}
	r, err := store.Live(s.ctx, query.LiveFilter{From: start.Add(-time.Second), To: start.Add(time.Second), Service: "case"})
	s.must("case-normalized Live", err)
	if len(r.Spans) != 1 || r.Spans[0].Occurrences != "2" || !r.Spans[0].Conflict || r.Spans[0].ParentConflict || r.Spans[0].TraceID != strings.Repeat("a", 32) || r.Spans[0].SpanID != strings.Repeat("b", 16) || r.Spans[0].ParentSpanID != strings.Repeat("c", 16) {
		t.Fatal("case-only IDs did not group or caused false parent ambiguity")
	}
	// Remove TTL only in this owned disposable database. Otherwise historical
	// epoch fixtures can disappear asynchronously before the rank assertion.
	_, err = db.ExecContext(s.ctx, "ALTER TABLE logice.otel_traces REMOVE TTL")
	s.must("disable disposable span TTL for epoch fixture", err)
	for _, ns := range []int64{-500000000, 0} {
		_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) VALUES (fromUnixTimestamp64Nano(?),'ffffffffffffffffffffffffffffffff','1111111111111111','epoch','epoch',map('logice.project.id','11111111-1111-4111-8111-111111111111'))`, ns)
		s.must("insert epoch conflict", err)
	}
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(toInt64(-100000000)),leftPad(hex(number+1),32,'0'),'1111111111111111','epoch','epoch',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(100)`)
	s.must("insert epoch group peers", err)
	r, err = store.Live(s.ctx, query.LiveFilter{From: time.Unix(-1, 0), To: time.Unix(1, 0), Service: "epoch"})
	s.must("epoch Live ranking", err)
	if len(r.Spans) != 100 || !r.TraceGroupsTruncated || r.Spans[0].TraceID != strings.Repeat("f", 32) || r.Spans[0].Occurrences != "2" || !r.Spans[0].StartTime.Equal(time.Unix(0, -500000000)) {
		t.Fatal("epoch-zero latest matching timestamp lost trace priority")
	}
}
