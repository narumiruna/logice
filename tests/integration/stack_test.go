//go:build integration

package integration

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
)

func TestStackFeasibility(t *testing.T) {
	s := newStack(t)
	pg, ch := s.databases()
	s.migrations(pg, ch)
	s.checkNonTransactionalFailure(ch)

	t.Log("export a parent/child trace and a correlated log over OTLP HTTP")
	fixture := newTelemetry(t)
	traceID := hex.EncodeToString(fixture.traceID)
	s.exportHTTP("/v1/traces", traceRequest(fixture.span("parent", fixture.parentID, nil), fixture.span("child", fixture.childID, fixture.parentID)), &collectortrace.ExportTraceServiceResponse{})
	s.exportHTTP("/v1/logs", fixture.logRequest(), &collectorlog.ExportLogsServiceResponse{})
	t.Log("export an additional span over OTLP gRPC")
	grpcID := s.exportGRPC(fixture)
	s.waitCount(ch, "otel_traces", traceID, 3)
	s.waitCount(ch, "otel_logs", traceID, 1)
	s.verifyTelemetry(ch, fixture, grpcID)
	s.verifyExporterSchema(ch)
	s.authChecks(ch)

	t.Log("stop ClickHouse briefly and verify bounded Collector retry recovery")
	s.run("stop", "--timeout", "3", "clickhouse")
	retryID, err := hex.DecodeString(randomHex(t, 8))
	s.must("create retry span identity", err)
	s.exportHTTP("/v1/traces", traceRequest(fixture.span("retry-proof", retryID, fixture.parentID)), &collectortrace.ExportTraceServiceResponse{})
	// Require an observed exporter retry while ClickHouse is still stopped,
	// not merely a batch buffered until after the restart.
	s.eventually("Collector exporter retry during outage", 12*time.Second, func(ctx context.Context) error {
		logs, err := s.compose(ctx, "logs", "--no-color", "--tail", "40", "collector")
		if err != nil {
			return err
		}
		if !strings.Contains(logs, "Will retry the request") {
			return fmt.Errorf("no exporter retry observed yet")
		}
		return nil
	})
	s.run("start", "clickhouse")
	s.refreshPorts()
	_ = pg.Close()
	_ = ch.Close()
	pg, ch = s.databases()
	s.waitCount(ch, "otel_traces", traceID, 4)
	var recovered uint64
	s.must("query retried span identity", ch.QueryRowContext(s.ctx, "SELECT count() FROM logice.otel_traces WHERE TraceId = ? AND SpanId = ? AND SpanName = ?", traceID, hex.EncodeToString(retryID), "retry-proof").Scan(&recovered))
	if recovered != 1 {
		t.Fatalf("expected exactly one recovered span, got %d", recovered)
	}

	t.Log("restart both databases and verify named-volume persistence")
	s.run("restart", "--timeout", "5", "postgres", "clickhouse")
	s.checkBindings()
	s.refreshPorts()
	_ = pg.Close()
	_ = ch.Close()
	pg, ch = s.databases()
	s.checkPersistence(pg, ch)
	s.waitCount(ch, "otel_traces", traceID, 4)
	s.waitCount(ch, "otel_logs", traceID, 1)
}
