//go:build integration

package integration

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	logs "go.opentelemetry.io/proto/otlp/logs/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type telemetry struct {
	traceID, parentID, childID []byte
	start                      time.Time
}

func newTelemetry(t *testing.T) telemetry {
	t.Helper()
	decode := func(size int) []byte {
		b, err := hex.DecodeString(randomHex(t, size))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	return telemetry{decode(16), decode(8), decode(8), time.Now().UTC()}
}

func textAttr(key, value string) *common.KeyValue {
	return &common.KeyValue{Key: key, Value: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: value}}}
}

func typedAttrs() []*common.KeyValue {
	return []*common.KeyValue{
		textAttr("validation.string", "preserved"),
		{Key: "validation.int", Value: &common.AnyValue{Value: &common.AnyValue_IntValue{IntValue: 42}}},
		{Key: "validation.bool", Value: &common.AnyValue{Value: &common.AnyValue_BoolValue{BoolValue: true}}},
		{Key: "validation.double", Value: &common.AnyValue{Value: &common.AnyValue_DoubleValue{DoubleValue: 1.5}}},
		textAttr("logice.project.id", "spoofed-client-project"),
	}
}

func fixtureResource() *resource.Resource {
	return &resource.Resource{Attributes: append(typedAttrs(), textAttr("service.name", "logice-validation"), textAttr("validation.resource", "custom-resource"))}
}

func (f telemetry) span(name string, id, parent []byte) *trace.Span {
	return &trace.Span{
		TraceId: f.traceID, SpanId: id, ParentSpanId: parent, Name: name,
		Kind:              trace.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: uint64(f.start.UnixNano()), EndTimeUnixNano: uint64(f.start.Add(25 * time.Millisecond).UnixNano()),
		Attributes: typedAttrs(), Status: &trace.Status{Code: trace.Status_STATUS_CODE_OK},
	}
}

func traceRequest(spans ...*trace.Span) *collectortrace.ExportTraceServiceRequest {
	return &collectortrace.ExportTraceServiceRequest{ResourceSpans: []*trace.ResourceSpans{{
		Resource: fixtureResource(), ScopeSpans: []*trace.ScopeSpans{{Scope: &common.InstrumentationScope{Name: "logice-feasibility"}, Spans: spans}},
	}}}
}

func (f telemetry) logRequest() *collectorlog.ExportLogsServiceRequest {
	return &collectorlog.ExportLogsServiceRequest{ResourceLogs: []*logs.ResourceLogs{{
		Resource: fixtureResource(), ScopeLogs: []*logs.ScopeLogs{{LogRecords: []*logs.LogRecord{{
			TimeUnixNano: uint64(f.start.Add(10 * time.Millisecond).UnixNano()), ObservedTimeUnixNano: uint64(time.Now().UnixNano()),
			TraceId: f.traceID, SpanId: f.childID, Flags: 1, SeverityNumber: logs.SeverityNumber_SEVERITY_NUMBER_INFO, SeverityText: "INFO",
			Body: &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: "correlated validation log"}}, Attributes: typedAttrs(),
		}}}},
	}}}
}

func (s *stack) post(path, token string, body []byte) (int, []byte) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+s.ports["http"]+path, bytes.NewReader(body))
	s.must("create OTLP HTTP request", err)
	req.Header.Set("Content-Type", "application/x-protobuf")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := s.http.Do(req)
	s.must("send OTLP HTTP request", err)
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	s.must("read OTLP HTTP response", err)
	return res.StatusCode, data
}

func (s *stack) exportHTTP(path string, request, response proto.Message) {
	s.t.Helper()
	body, err := proto.Marshal(request)
	s.must("encode OTLP request", err)
	status, data := s.post(path, s.secrets[2], body)
	if status != http.StatusOK {
		s.t.Fatalf("authenticated OTLP %s returned HTTP %d", path, status)
	}
	s.must("decode OTLP response", proto.Unmarshal(data, response))
	switch result := response.(type) {
	case *collectortrace.ExportTraceServiceResponse:
		if result.GetPartialSuccess().GetRejectedSpans() != 0 {
			s.t.Fatal("Collector rejected HTTP spans")
		}
	case *collectorlog.ExportLogsServiceResponse:
		if result.GetPartialSuccess().GetRejectedLogRecords() != 0 {
			s.t.Fatal("Collector rejected HTTP logs")
		}
	}
}

func (s *stack) authChecks(db *sql.DB) {
	s.t.Helper()
	s.t.Log("check HTTP/gRPC ingestion authentication and malformed HTTP requests")
	baseline := make(map[string]uint64)
	for _, table := range []string{"otel_traces", "otel_logs"} {
		count, err := s.count(db, table, "")
		s.must("count baseline "+table+" rows", err)
		baseline[table] = count
	}
	unauthorized := newTelemetry(s.t)
	for _, target := range []struct {
		path    string
		request proto.Message
	}{{"/v1/traces", traceRequest(unauthorized.span("unauthorized", unauthorized.parentID, nil))}, {"/v1/logs", unauthorized.logRequest()}} {
		payload, err := proto.Marshal(target.request)
		s.must("encode unauthorized fixture", err)
		for _, token := range []string{"", "invalid-" + randomHex(s.t, 8)} {
			status, _ := s.post(target.path, token, payload)
			if status != http.StatusUnauthorized && status != http.StatusForbidden {
				s.t.Fatalf("unauthorized %s returned HTTP %d, expected 401 or 403", target.path, status)
			}
		}
		status, _ := s.post(target.path, s.secrets[2], []byte{0xff})
		if status < 400 || status >= 500 {
			s.t.Fatalf("malformed authenticated %s returned HTTP %d, expected 4xx", target.path, status)
		}
	}
	conn, err := grpc.NewClient(s.ports["grpc"], grpc.WithTransportCredentials(insecure.NewCredentials()))
	s.must("create gRPC authentication test client", err)
	defer conn.Close()
	for _, token := range []string{"", "invalid-" + randomHex(s.t, 8)} {
		for _, export := range []func(context.Context) error{
			func(ctx context.Context) error {
				_, err := collectortrace.NewTraceServiceClient(conn).Export(ctx, traceRequest(unauthorized.span("unauthorized", unauthorized.parentID, nil)))
				return err
			},
			func(ctx context.Context) error {
				_, err := collectorlog.NewLogsServiceClient(conn).Export(ctx, unauthorized.logRequest())
				return err
			},
		} {
			ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
			if token != "" {
				ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
			}
			err := export(ctx)
			cancel()
			if code := status.Code(err); code != codes.Unauthenticated && code != codes.PermissionDenied {
				s.t.Fatalf("unauthorized gRPC export returned %s, expected Unauthenticated or PermissionDenied", code)
			}
		}
	}
	// Allow a batch interval to pass before checking that rejected payloads
	// did not create rows. Tables already exist after the successful export.
	select {
	case <-time.After(2 * time.Second):
	case <-s.ctx.Done():
		s.t.Fatal("test deadline while checking rejected ingestion")
	}
	for _, table := range []string{"otel_traces", "otel_logs"} {
		total, err := s.count(db, table, "")
		s.must("count "+table+" rows after rejected requests", err)
		if total != baseline[table] {
			s.t.Errorf("rejected requests changed %s row count from %d to %d", table, baseline[table], total)
		}
		count, err := s.count(db, table, hex.EncodeToString(unauthorized.traceID))
		s.must("count unauthorized "+table+" rows", err)
		if count != 0 {
			s.t.Fatalf("unauthorized requests created %d %s rows", count, table)
		}
	}
}

func (s *stack) exportGRPC(f telemetry) string {
	s.t.Helper()
	id, err := hex.DecodeString(randomHex(s.t, 8))
	s.must("create gRPC span identity", err)
	conn, err := grpc.NewClient(s.ports["grpc"], grpc.WithTransportCredentials(insecure.NewCredentials()))
	s.must("create OTLP gRPC client", err)
	defer conn.Close()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+s.secrets[2])
	result, err := collectortrace.NewTraceServiceClient(conn).Export(ctx, traceRequest(f.span("grpc-proof", id, f.parentID)))
	s.must("export actual OTLP gRPC span", err)
	if result.GetPartialSuccess().GetRejectedSpans() != 0 {
		s.t.Fatal("Collector rejected gRPC span")
	}
	return hex.EncodeToString(id)
}

func (s *stack) waitCount(db *sql.DB, table, traceID string, expected uint64) {
	s.t.Helper()
	s.eventually(fmt.Sprintf("%d %s rows", expected, table), 60*time.Second, func(context.Context) error {
		count, err := s.count(db, table, traceID)
		if err != nil {
			return err
		}
		if count != expected {
			return fmt.Errorf("got %d rows, expected %d", count, expected)
		}
		return nil
	})
}

func checkAttrs(t *testing.T, attrs map[string]string, resourceAttrs bool) {
	t.Helper()
	// The default exporter schema is Map(LowCardinality(String), String),
	// not a typed map.
	// OTLP scalar types must retain their value after string conversion.
	for key, expected := range map[string]string{
		"validation.string": "preserved", "validation.int": "42", "validation.bool": "true", "validation.double": "1.5",
	} {
		if attrs[key] != expected {
			t.Errorf("attribute %s = %q, expected %q", key, attrs[key], expected)
		}
	}
	project, exists := attrs["logice.project.id"]
	if resourceAttrs {
		if project != "validation" || attrs["validation.resource"] != "custom-resource" || attrs["service.name"] != "logice-validation" {
			t.Error("trusted resource identity or custom resource attribute was not preserved")
		}
	} else if exists && project != "validation" {
		t.Error("untrusted project identity survived in record attributes")
	}
}

func (s *stack) verifyTelemetry(db *sql.DB, f telemetry, grpcID string) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT SpanId, ParentSpanId, SpanName, ServiceName, Duration, Timestamp, ResourceAttributes, SpanAttributes
FROM logice.otel_traces WHERE TraceId = ?`, hex.EncodeToString(f.traceID))
	s.must("query trace tree with native Go driver", err)
	defer rows.Close()
	seen := make(map[string]bool)
	for rows.Next() {
		var id, parent, name, service string
		var duration uint64
		var timestamp time.Time
		var resourceAttrs, spanAttrs map[string]string
		s.must("scan trace row", rows.Scan(&id, &parent, &name, &service, &duration, &timestamp, &resourceAttrs, &spanAttrs))
		expectedParent := hex.EncodeToString(f.parentID)
		switch id {
		case hex.EncodeToString(f.parentID):
			expectedParent = ""
			if name != "parent" {
				s.t.Error("parent span name was not preserved")
			}
		case hex.EncodeToString(f.childID):
			if name != "child" {
				s.t.Error("child span name was not preserved")
			}
		case grpcID:
			if name != "grpc-proof" {
				s.t.Error("gRPC span name was not preserved")
			}
		default:
			s.t.Error("unexpected span identity")
		}
		if seen[id] || parent != expectedParent || service != "logice-validation" || duration != uint64(25*time.Millisecond) || !timestamp.Equal(f.start) {
			s.t.Error("trace identity, parent link, service, duration, timestamp, or uniqueness was not preserved")
		}
		seen[id] = true
		checkAttrs(s.t, resourceAttrs, true)
		checkAttrs(s.t, spanAttrs, false)
	}
	s.must("read trace rows", rows.Err())
	if len(seen) != 3 {
		s.t.Errorf("expected three distinct HTTP/gRPC spans, got %d", len(seen))
	}
	var spanID, service, body, severity string
	var timestamp time.Time
	var resourceAttrs, logAttrs map[string]string
	s.must("query correlated log", db.QueryRowContext(ctx, `SELECT SpanId, ServiceName, Body, SeverityText, Timestamp, ResourceAttributes, LogAttributes
FROM logice.otel_logs WHERE TraceId = ?`, hex.EncodeToString(f.traceID)).Scan(&spanID, &service, &body, &severity, &timestamp, &resourceAttrs, &logAttrs))
	if spanID != hex.EncodeToString(f.childID) || service != "logice-validation" || body != "correlated validation log" || severity != "INFO" || !timestamp.Equal(f.start.Add(10*time.Millisecond)) {
		s.t.Error("log correlation, service, body, severity, or timestamp was not preserved")
	}
	checkAttrs(s.t, resourceAttrs, true)
	checkAttrs(s.t, logAttrs, false)
}
