//go:build integration

package integration

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	query "github.com/narumiruna/logice/internal/telemetry"
)

func overviewResources(t *testing.T, s *stack, db *sql.DB, store *query.Store, start time.Time) {
	t.Helper()
	_, err := db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces(Timestamp,TraceId,SpanId,ParentSpanId,SpanName,ServiceName,ResourceAttributes,Duration,StatusCode) SELECT fromUnixTimestamp64Nano(?+toInt64(number)),leftPad(hex(number+1),32,'0'),leftPad(hex(number+1),16,'0'),'','overview-load','overview-load',map('logice.project.id','11111111-1111-4111-8111-111111111111'),toUInt64(1000000+number),if(number%10=0,'Error','Unset') FROM numbers(5000)`, start.UnixNano())
	s.must("seed overview spans", err)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_logs(Timestamp,Body,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?+toInt64(number)),concat('overview-',toString(number)),'overview-load',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(5000)`, start.UnixNano())
	s.must("seed overview logs", err)
	filter := query.Filter{From: start.Add(-time.Second), To: start.Add(time.Second), Service: "overview-load", Limit: 1}
	ctx := query.WithProject(s.ctx, fixtureProject)
	result, err := store.Overview(ctx, filter)
	s.must("overview independent of row limit", err)
	if result.Traces != "5000" || result.Logs != "5000" || result.ErrorTraces != "500" || result.RootSpans != "5000" || result.P50NS == nil || *result.P50NS != "1002500" || result.P95NS == nil || *result.P95NS != "1004750" {
		t.Fatal("full-window counts/quantiles incorrect", result.OverviewStats)
	}
	durations := []time.Duration{}
	for i := 0; i < 32; i++ {
		before := time.Now()
		_, err := store.Overview(ctx, filter)
		s.must("overview benchmark", err)
		if i >= 2 {
			durations = append(durations, time.Since(before))
		}
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	p95 := durations[28]
	t.Logf("Overview 5000 spans/5000 logs, 2 warmups and 30 reads: p50=%s p95=%s max=%s", durations[14], p95, durations[29])
	if p95 > 2*time.Second {
		t.Fatal("overview local p95 exceeds two seconds")
	}
	logged := clickhouse.OpenDB(&clickhouse.Options{Addr: []string{s.ports["clickhouse"]}, Auth: clickhouse.Auth{Database: "logice", Username: "logice", Password: s.secrets[1]}, Settings: clickhouse.Settings{"log_queries": 1, "log_query_settings": 1}})
	resourceStore := query.NewStore(logged)
	defer resourceStore.Close()
	id := "overview-settings-" + randomHex(t, 8)
	_, err = resourceStore.Overview(clickhouse.Context(ctx, clickhouse.WithQueryID(id)), filter)
	s.must("overview settings", err)
	_, err = db.ExecContext(s.ctx, "SYSTEM FLUSH LOGS")
	s.must("flush overview settings", err)
	var total, bounded uint64
	s.must("actual overview resource limits", db.QueryRowContext(s.ctx, `SELECT count(),countIf(Settings['readonly']='1' AND Settings['max_execution_time']='5' AND Settings['max_memory_usage']='134217728' AND Settings['max_result_bytes']='8388608' AND Settings['result_overflow_mode'] IN ('','throw') AND Settings['timeout_overflow_mode'] IN ('','throw')) FROM system.query_log WHERE query_id=? AND type='QueryFinish'`, id).Scan(&total, &bounded))
	if total != 2 || bounded != 2 {
		t.Fatal("overview driver changed effective bounds", total, bounded)
	}
	heavy := start.Add(time.Minute)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces(Timestamp,TraceId,SpanId,SpanName,ServiceName,ResourceAttributes) SELECT fromUnixTimestamp64Nano(?),'dddddddddddddddddddddddddddddddd',leftPad(hex(number+1),16,'0'),concat('heavy-',toString(number)),'overview-heavy',map('logice.project.id','11111111-1111-4111-8111-111111111111') FROM numbers(500000)`, heavy.UnixNano())
	s.must("overview heavy memory fixture", err)
	heavyFilter := query.Filter{From: heavy.Add(-time.Second), To: heavy.Add(time.Second), Service: "overview-heavy"}
	cancelCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var progressed atomic.Bool
	cancelCtx = clickhouse.Context(cancelCtx, clickhouse.WithProgress(func(*clickhouse.Progress) { progressed.Store(true); cancel() }))
	before := time.Now()
	_, err = store.Overview(cancelCtx, heavyFilter)
	if err == nil || !progressed.Load() || time.Since(before) > time.Second {
		t.Fatal("overview active cancellation not bounded", progressed.Load(), time.Since(before))
	}
	_, err = store.Overview(ctx, heavyFilter)
	var exception *clickhouse.Exception
	if !errors.As(err, &exception) || exception.Code != 241 {
		t.Fatal("overview memory overflow returned partial totals instead of a bounded failure", err)
	}
}
