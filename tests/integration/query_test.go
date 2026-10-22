//go:build integration

package integration

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/logice/internal/httpapi"
	query "github.com/narumiruna/logice/internal/telemetry"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	logs "go.opentelemetry.io/proto/otlp/logs/v1"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
)

// Query the actual Collector schema through HTTP, not a database mock.
func TestTelemetryQueries(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("open application query store", err)
	t.Cleanup(func() { _ = store.Close() })
	server := httptest.NewServer(httpapi.NewServer(store).Handler)
	t.Cleanup(server.Close)
	get := func(path string, result any) int {
		t.Helper()
		req, err := http.NewRequestWithContext(s.ctx, http.MethodGet, server.URL+path, nil)
		s.must("create query API request", err)
		res, err := s.http.Do(req)
		s.must("query telemetry API", err)
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		s.must("read query API response", err)
		if res.Header.Get("Content-Type") != "application/json" {
			t.Fatal("query response is not JSON")
		}
		if result != nil {
			s.must("decode query API response", json.Unmarshal(body, result))
		}
		if res.StatusCode >= 500 && strings.Contains(string(body), s.secrets[1]) {
			t.Fatal("query response exposed storage credentials")
		}
		return res.StatusCode
	}
	var empty struct {
		Items   []json.RawMessage `json:"items"`
		HasMore bool              `json:"hasMore"`
	}
	if status := get("/api/traces", &empty); status != 200 || empty.Items == nil || len(empty.Items) != 0 || empty.HasMore {
		t.Fatal("fresh Collector must return an empty trace list")
	}
	if status := get("/api/logs", &empty); status != 200 || empty.Items == nil || len(empty.Items) != 0 {
		t.Fatal("fresh Collector must return an empty log list")
	}

	fixture := newTelemetry(t)
	id := hex.EncodeToString(fixture.traceID)
	root := fixture.span("query-root", fixture.parentID, nil)
	child := fixture.span("query-child", fixture.childID, fixture.parentID)
	child.Status = &trace.Status{Code: trace.Status_STATUS_CODE_ERROR, Message: "query failure"}
	s.exportHTTP("/v1/traces", traceRequest(root, child), &collectortrace.ExportTraceServiceResponse{})
	other := newTelemetry(t)
	other.start = fixture.start
	s.exportHTTP("/v1/traces", traceRequest(other.span("healthy", other.parentID, nil)), &collectortrace.ExportTraceServiceResponse{})
	logRequest := fixture.logRequest()
	second := fixture.logRequest().ResourceLogs[0].ScopeLogs[0].LogRecords[0]
	second.Body = &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: "literal ' % _ search"}}
	second.SeverityNumber, second.SeverityText = logs.SeverityNumber_SEVERITY_NUMBER_ERROR, "ERROR"
	second.TimeUnixNano = uint64(fixture.start.Add(20 * time.Millisecond).UnixNano())
	logRequest.ResourceLogs[0].ScopeLogs[0].LogRecords = append(logRequest.ResourceLogs[0].ScopeLogs[0].LogRecords, second)
	s.exportHTTP("/v1/logs", logRequest, &collectorlog.ExportLogsServiceResponse{})
	s.waitCount(db, "otel_traces", id, 2)
	s.waitCount(db, "otel_logs", id, 2)
	s.waitCount(db, "otel_traces", hex.EncodeToString(other.traceID), 1)

	// Same trace/span IDs in another project must never appear in any API result.
	for _, target := range []struct{ table, column string }{{"otel_traces", "SpanName"}, {"otel_logs", "Body"}} {
		statement := "INSERT INTO logice." + target.table + " SELECT * REPLACE (mapUpdate(ResourceAttributes, map('logice.project.id', 'foreign')) AS ResourceAttributes, 'foreign-project' AS " + target.column + ") FROM logice." + target.table + " WHERE TraceId = ? LIMIT 1"
		_, err := db.ExecContext(s.ctx, statement, id)
		s.must("insert isolated foreign-project query fixture", err)
	}
	window := url.Values{"from": {fixture.start.Add(-time.Second).Format(time.RFC3339Nano)}, "to": {fixture.start.Add(time.Second).Format(time.RFC3339Nano)}}
	path := func(route string, extra url.Values) string {
		params := url.Values{}
		for key, values := range window {
			params[key] = values
		}
		for key, values := range extra {
			params[key] = values
		}
		return route + "?" + params.Encode()
	}
	var traces struct {
		Items []struct {
			TraceID, Name, ServiceName, StartTime, DurationNS string
			SpanCount, ErrorCount                             int
		} `json:"items"`
		HasMore bool `json:"hasMore"`
	}
	if get(path("/api/traces", nil), &traces) != 200 || len(traces.Items) != 2 || traces.HasMore {
		t.Fatal("trace list must contain two validation-project traces")
	}
	found := false
	for _, item := range traces.Items {
		if item.TraceID == id {
			found = true
			if item.Name != "query-root" || item.SpanCount != 2 || item.ErrorCount != 1 || item.DurationNS != "25000000" || item.StartTime != fixture.start.Format(time.RFC3339Nano) {
				t.Fatalf("trace summary changed: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("trace list omitted ingested trace")
	}
	if get(path("/api/traces", url.Values{"limit": {"1"}}), &traces) != 200 || len(traces.Items) != 1 || !traces.HasMore {
		t.Fatal("trace limit must signal additional results")
	}
	if get(path("/api/traces", url.Values{"errorsOnly": {"true"}}), &traces) != 200 || len(traces.Items) != 1 || traces.Items[0].TraceID != id {
		t.Fatal("error filter did not select the failed trace")
	}
	for _, filters := range []url.Values{{"service": {"' OR 1=1 --"}}, {"search": {"foreign-project"}}} {
		if get(path("/api/traces", filters), &traces) != 200 || len(traces.Items) != 0 {
			t.Fatal("trace filter escaped parameter or project bounds")
		}
	}
	var detail struct {
		TraceID string `json:"traceId"`
		Spans   []struct {
			SpanID, ParentSpanID, StartTime, DurationNS, StatusCode string
			ResourceAttributes, Attributes                          map[string]string
		} `json:"spans"`
		Logs           []json.RawMessage `json:"logs"`
		SpansTruncated bool              `json:"spansTruncated"`
		LogsTruncated  bool              `json:"logsTruncated"`
	}
	if get(path("/api/traces/"+id, nil), &detail) != 200 || detail.TraceID != id || len(detail.Spans) != 2 || len(detail.Logs) != 2 || detail.SpansTruncated || detail.LogsTruncated {
		t.Fatal("trace detail lost spans/logs or included a foreign project")
	}
	for _, span := range detail.Spans {
		if span.StartTime != fixture.start.Format(time.RFC3339Nano) || span.DurationNS != "25000000" || span.ResourceAttributes["logice.project.id"] != "validation" || span.Attributes["validation.int"] != "42" {
			t.Fatal("trace detail lost nanoseconds or attributes")
		}
		if span.SpanID == hex.EncodeToString(fixture.childID) && (span.ParentSpanID != hex.EncodeToString(fixture.parentID) || span.StatusCode != "Error") {
			t.Fatal("trace detail lost hierarchy or error status")
		}
	}
	var records struct {
		Items []struct {
			Body, TraceID, SpanID, Timestamp string
			SeverityNumber                   int
			ResourceAttributes, Attributes   map[string]string
		} `json:"items"`
		HasMore bool `json:"hasMore"`
	}
	if get(path("/api/logs", url.Values{"limit": {"1"}}), &records) != 200 || len(records.Items) != 1 || !records.HasMore {
		t.Fatal("log limit must signal additional results")
	}
	if get(path("/api/logs", url.Values{"search": {"%"}, "minSeverity": {"17"}, "traceId": {id}}), &records) != 200 || len(records.Items) != 1 || records.Items[0].Body != "literal ' % _ search" || records.Items[0].SeverityNumber != 17 {
		t.Fatal("log search must treat percent as literal text and retain severity/correlation")
	}
	if item := records.Items[0]; item.Timestamp != fixture.start.Add(20*time.Millisecond).Format(time.RFC3339Nano) || item.ResourceAttributes["logice.project.id"] != "validation" || item.Attributes["validation.bool"] != "true" {
		t.Fatal("log detail lost time or attributes")
	}
	// A one-nanosecond window includes the span start and excludes later logs.
	boundary := url.Values{"from": {fixture.start.Format(time.RFC3339Nano)}, "to": {fixture.start.Add(time.Nanosecond).Format(time.RFC3339Nano)}}
	if get(path("/api/traces", boundary), &traces) != 200 || len(traces.Items) != 2 {
		t.Fatal("inclusive from boundary lost nanosecond span starts")
	}
	boundary.Set("from", fixture.start.Add(-time.Nanosecond).Format(time.RFC3339Nano))
	boundary.Set("to", fixture.start.Format(time.RFC3339Nano))
	if get(path("/api/traces", boundary), &traces) != 200 || len(traces.Items) != 0 {
		t.Fatal("exclusive to boundary included a span at to")
	}
	if get(path("/api/traces/"+randomHex(t, 16), nil), nil) != 404 {
		t.Fatal("unknown trace must return JSON 404")
	}
	for _, route := range []string{"/api/traces?project=foreign", "/api/traces?limit=101", "/api/logs?minSeverity=25", "/api/traces/not-a-trace-id"} {
		if get(route, nil) != 400 {
			t.Fatalf("malformed query was not rejected: %s", route)
		}
	}
	// Server-side detail caps apply even when a trace has more stored records.
	cappedID := randomHex(t, 16)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_traces (Timestamp, TraceId, SpanId, SpanName, ServiceName, Duration, ResourceAttributes)
SELECT fromUnixTimestamp64Nano(?), ?, leftPad(toString(number), 16, '0'), 'bounded', 'caps', toUInt64(1), map('logice.project.id', 'validation') FROM numbers(501)`, fixture.start.UnixNano(), cappedID)
	s.must("insert bounded span fixture", err)
	_, err = db.ExecContext(s.ctx, `INSERT INTO logice.otel_logs (Timestamp, TraceId, Body, ResourceAttributes)
SELECT fromUnixTimestamp64Nano(?), ?, 'bounded log', map('logice.project.id', 'validation') FROM numbers(201)`, fixture.start.UnixNano(), cappedID)
	s.must("insert bounded log fixture", err)
	if get(path("/api/traces/"+cappedID, nil), &detail) != 200 || len(detail.Spans) != 500 || len(detail.Logs) != 200 || !detail.SpansTruncated || !detail.LogsTruncated {
		t.Fatal("trace detail must cap and flag excessive span/log results")
	}
	if err := store.Close(); err != nil {
		s.must("close query store for outage check", err)
	}
	if get(path("/api/traces", nil), nil) != 503 || get("/api/healthz", nil) != 200 {
		t.Fatal("storage failure must return 503 without failing liveness")
	}
}
