//go:build integration

package integration

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"testing"
	"time"

	fixture "github.com/narumiruna/logice/tests/fixtures/telemetry"
	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// Expected conversions were recorded from the pinned source in
// docs/telemetry-compatibility.md before these integration assertions.
func expectedCompatibilityAttrs(location string) map[string]string {
	attrs := map[string]string{
		"array": `["alpha",42,true,1.5]`, "nested": `{"inner":{"enabled":true},"logice.project.id":"nested-spoof"}`,
		"empty": "", "empty.array": "[]", "empty.map": "{}", "bytes": "AP8=",
		"int.min": "-9223372036854775808", "int.max": "9223372036854775807",
		"double.max": "1.7976931348623157e+308", "double.min": "5e-324",
		"nan": "NaN", "inf": "Infinity", "negative.inf": "-Infinity", "nested.nan": "",
	}
	switch location {
	case "resource":
		attrs["logice.project.id"] = fixtureProject
		attrs["service.name"] = "deterministic-telemetry"
	case "record": // The configured processor deletes this key, not just its value.
	default:
		attrs["logice.project.id"] = `{"untrusted":["spoof"]}`
	}
	return attrs
}

func (s *stack) checkCompatibilityAttrs(got map[string]string, location string) {
	s.t.Helper()
	if want := expectedCompatibilityAttrs(location); !reflect.DeepEqual(got, want) {
		s.t.Errorf("%s attribute conversion differs: got %#v; want %#v", location, got, want)
	}
}

func (s *stack) compatibilityExport(conn *grpc.ClientConn, protocol, token string, request proto.Message, authorized bool) {
	s.t.Helper()
	path := "/v1/traces"
	var response proto.Message
	switch request.(type) {
	case *collectortrace.ExportTraceServiceRequest:
		response = &collectortrace.ExportTraceServiceResponse{}
	case *collectorlog.ExportLogsServiceRequest:
		path = "/v1/logs"
		response = &collectorlog.ExportLogsServiceResponse{}
	default:
		s.t.Fatal("unsupported compatibility request")
	}
	if protocol == "http" {
		data, err := proto.Marshal(request)
		s.must("encode compatibility request", err)
		if authorized {
			token = s.applicationToken
		}
		code, body := s.post(path, token, data)
		if !authorized {
			if code != 401 && code != 403 {
				s.t.Fatalf("expanded unauthenticated %s returned HTTP %d", path, code)
			}
			return
		}
		if code != 200 {
			s.t.Fatalf("compatibility %s returned HTTP %d", path, code)
		}
		s.must("decode compatibility response", proto.Unmarshal(body, response))
	} else {
		ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
		defer cancel()
		if token != "" {
			ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token, "x-logice-project-id", fixtureProject)
		}
		var err error
		switch r := request.(type) {
		case *collectortrace.ExportTraceServiceRequest:
			response, err = collectortrace.NewTraceServiceClient(conn).Export(ctx, r)
		case *collectorlog.ExportLogsServiceRequest:
			response, err = collectorlog.NewLogsServiceClient(conn).Export(ctx, r)
		}
		if !authorized {
			if code := status.Code(err); code != codes.Unauthenticated && code != codes.PermissionDenied {
				s.t.Fatalf("expanded unauthenticated %s returned gRPC %s", path, code)
			}
			return
		}
		s.must("export compatibility gRPC request", err)
	}
	switch r := response.(type) {
	case *collectortrace.ExportTraceServiceResponse:
		if r.GetPartialSuccess().GetRejectedSpans() != 0 || r.GetPartialSuccess().GetErrorMessage() != "" {
			s.t.Fatal("trace compatibility export returned partial success")
		}
	case *collectorlog.ExportLogsServiceResponse:
		if r.GetPartialSuccess().GetRejectedLogRecords() != 0 || r.GetPartialSuccess().GetErrorMessage() != "" {
			s.t.Fatal("log compatibility export returned partial success")
		}
	}
}

func TestTelemetryCompatibility(t *testing.T) {
	s := newStack(t)
	_, ch := s.databases()
	conn, err := grpc.NewClient(s.ports["grpc"], grpc.WithTransportCredentials(insecure.NewCredentials()))
	s.must("create compatibility gRPC client", err)
	defer conn.Close()
	// IDs and relative times are deterministic. Only this one clock read avoids TTL expiry.
	base := time.Now().UTC()
	var totalSpans, totalLogs uint64
	for i, protocol := range []string{"http", "grpc"} {
		protocolBase := base.Add(time.Duration(i) * time.Second)
		for _, c := range fixture.Generate(uint32(7+i), protocolBase) {
			t.Logf("%s fixture %s: %d spans, %d logs", protocol, c.Name, c.Manifest.SpanCount, c.Manifest.LogCount)
			for batch, request := range c.Batches {
				s.compatibilityExport(conn, protocol, s.secrets[2], request, true)
				if c.Name == "later-parent" && batch == 0 {
					s.waitCount(ch, "otel_traces", c.Manifest.TraceID, 1)
					ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
					var child, parent string
					s.must("observe later-parent child before parent delivery", ch.QueryRowContext(ctx, `SELECT SpanId, ParentSpanId FROM logice.otel_traces WHERE TraceId = ?`, c.Manifest.TraceID).Scan(&child, &parent))
					var parents uint64
					s.must("observe absent later parent", ch.QueryRowContext(ctx, `SELECT count() FROM logice.otel_traces WHERE TraceId = ? AND SpanId = ?`, c.Manifest.TraceID, c.Manifest.Spans[0].ID).Scan(&parents))
					cancel()
					if child != c.Manifest.Spans[1].ID || parent != c.Manifest.Spans[0].ID || parents != 0 {
						t.Fatal("later-parent intermediate identity state differs")
					}
				}
			}
			if c.Manifest.SpanCount > 0 {
				s.waitCount(ch, "otel_traces", c.Manifest.TraceID, uint64(c.Manifest.SpanCount))
				s.verifyCompatibilitySpans(ch, c)
			}
			s.compatibilityExport(conn, protocol, s.secrets[2], c.Logs, true)
			totalSpans += uint64(c.Manifest.SpanCount)
			totalLogs += uint64(c.Manifest.LogCount)
			s.waitCount(ch, "otel_logs", "", totalLogs)
			s.verifyCompatibilityLogs(ch, c, protocolBase)
		}
	}
	if totalSpans != 56 || totalLogs != 34 {
		t.Fatalf("fixture matrix totals changed: %d spans, %d logs; want 56 and 34", totalSpans, totalLogs)
	}
	s.waitCount(ch, "otel_traces", "", totalSpans)
	s.verifyExporterSchema(ch)
	s.verifyCompatibilitySchema(ch)
	// Both empty export and rejection evidence use complete-table baselines, which
	// also include uncorrelated logs. No trace filter can hide those rows.
	for _, protocol := range []string{"http", "grpc"} {
		s.compatibilityExport(conn, protocol, s.secrets[2], &collectortrace.ExportTraceServiceRequest{}, true)
		s.compatibilityExport(conn, protocol, s.secrets[2], &collectorlog.ExportLogsServiceRequest{}, true)
	}
	rejected := fixture.Generate(99, base)[7]
	for _, protocol := range []string{"http", "grpc"} {
		for _, token := range []string{"", "invalid-" + randomHex(t, 8)} {
			s.compatibilityExport(conn, protocol, token, rejected.Batches[0], false)
			s.compatibilityExport(conn, protocol, token, rejected.Logs, false)
		}
	}
	// Protocol rejection is primary evidence. The bounded quiet window also
	// checks that neither rejected nor empty requests enter the exporter queue.
	timer := time.NewTimer(2500 * time.Millisecond)
	defer timer.Stop()
	for {
		for table, want := range map[string]uint64{"otel_traces": totalSpans, "otel_logs": totalLogs} {
			got, err := s.count(ch, table, "")
			s.must("count rows after empty/rejected expanded exports", err)
			if got != want {
				t.Fatalf("empty/rejected exports changed %s count: got %d want %d", table, got, want)
			}
		}
		select {
		case <-timer.C:
			return
		case <-s.ctx.Done():
			t.Fatal("deadline while checking rejected expanded exports")
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *stack) verifyCompatibilitySpans(db *sql.DB, c fixture.Case) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, `SELECT SpanId, ParentSpanId, SpanName, Timestamp, Duration, ResourceAttributes, SpanAttributes, ScopeName, ScopeVersion,
 Events.Timestamp, Events.Name, Events.Attributes, Links.TraceId, Links.SpanId, Links.TraceState, Links.Attributes
 FROM logice.otel_traces WHERE TraceId = ?`, c.Manifest.TraceID)
	s.must("query compatibility trace columns", err)
	defer rows.Close()
	expected := map[string]int{}
	for i, span := range c.Manifest.Spans {
		expected[span.ID] = i
	}
	seen := map[string]bool{}
	for rows.Next() {
		var id, parent, name, scopeName, scopeVersion string
		var timestamp time.Time
		var duration uint64
		var resourceAttrs, attrs map[string]string
		var eventTimes []time.Time
		var eventNames, linkTraces, linkSpans, linkStates []string
		var eventAttrs, linkAttrs []map[string]string
		s.must("scan compatibility span and Nested columns", rows.Scan(&id, &parent, &name, &timestamp, &duration, &resourceAttrs, &attrs, &scopeName, &scopeVersion, &eventTimes, &eventNames, &eventAttrs, &linkTraces, &linkSpans, &linkStates, &linkAttrs))
		ordinal, ok := expected[id]
		if !ok || seen[id] {
			s.t.Fatalf("%s unexpected/duplicate stored span %s", c.Name, id)
		}
		seen[id] = true
		want := c.Manifest.Spans[ordinal]
		if parent != want.ParentID || name != fmt.Sprintf("%s-%d", c.Name, ordinal+1) || !timestamp.Equal(want.Start) || duration != 1234567 || scopeName != "fixture-scope" || scopeVersion != "1.2.3" {
			s.t.Errorf("%s span %s identity/parent/time/scope differs", c.Name, id)
		}
		s.checkCompatibilityAttrs(resourceAttrs, "resource")
		s.checkCompatibilityAttrs(attrs, "record")
		if len(eventTimes) != 1 || !eventTimes[0].Equal(want.Start.Add(7*time.Nanosecond)) || !reflect.DeepEqual(eventNames, []string{"fixture-event"}) || len(eventAttrs) != 1 {
			s.t.Fatal("event Nested columns differ")
		}
		s.checkCompatibilityAttrs(eventAttrs[0], "event")
		if !reflect.DeepEqual(linkTraces, []string{c.Manifest.TraceID}) || !reflect.DeepEqual(linkSpans, []string{c.Manifest.Spans[0].ID}) || !reflect.DeepEqual(linkStates, []string{"vendor=value"}) || len(linkAttrs) != 1 {
			s.t.Fatal("link Nested columns differ")
		}
		s.checkCompatibilityAttrs(linkAttrs[0], "link")
	}
	s.must("read compatibility trace rows", rows.Err())
	if len(seen) != len(expected) {
		s.t.Fatalf("%s stored identity count %d, want %d", c.Name, len(seen), len(expected))
	}
	// Missing parents remain missing: the exporter does not construct a tree.
	for _, span := range c.Manifest.Spans {
		if span.ParentID == "" {
			continue
		}
		if _, ok := expected[span.ParentID]; ok {
			continue
		}
		var count uint64
		s.must("query orphan parent absence", db.QueryRowContext(ctx, `SELECT count() FROM logice.otel_traces WHERE TraceId = ? AND SpanId = ?`, c.Manifest.TraceID, span.ParentID).Scan(&count))
		if count != 0 {
			s.t.Fatal("exporter synthesized an orphan parent")
		}
	}
}

func (s *stack) verifyCompatibilityLogs(db *sql.DB, c fixture.Case, base time.Time) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	defer cancel()
	// Bodies and a disjoint deterministic time range identify every log,
	// including logs without trace/span IDs. SQL row order is not significant.
	rows, err := db.QueryContext(ctx, `SELECT Body, TraceId, SpanId, Timestamp, ResourceAttributes, LogAttributes, ScopeName, ScopeVersion, ScopeAttributes,
 ResourceSchemaUrl, ScopeSchemaUrl, TraceFlags, SeverityNumber, SeverityText
 FROM logice.otel_logs WHERE Body IN (?, ?, ?) AND toUnixTimestamp64Nano(Timestamp) >= ? AND toUnixTimestamp64Nano(Timestamp) < ?`, c.Manifest.Logs[0].Body, c.Manifest.Logs[1].Body, fmt.Sprintf("%s-log-3", c.Name), base.UnixNano(), base.Add(time.Second).UnixNano())
	s.must("query compatibility log columns", err)
	defer rows.Close()
	expected := map[string]fixture.Log{}
	for _, log := range c.Manifest.Logs {
		expected[log.Body] = log
	}
	seen := map[string]int{}
	for rows.Next() {
		var body, traceID, spanID, scopeName, scopeVersion, resourceURL, scopeURL, severity string
		var flags, severityNumber uint8
		var timestamp time.Time
		var resourceAttrs, attrs, scopeAttrs map[string]string
		s.must("scan compatibility log", rows.Scan(&body, &traceID, &spanID, &timestamp, &resourceAttrs, &attrs, &scopeName, &scopeVersion, &scopeAttrs, &resourceURL, &scopeURL, &flags, &severityNumber, &severity))
		want, ok := expected[body]
		if !ok {
			s.t.Fatal("unexpected log body")
		}
		seen[body]++
		if traceID != want.TraceID || spanID != want.SpanID || !timestamp.Equal(want.Time) || flags != 1 || severityNumber != 9 || severity != "INFO" || scopeName != "fixture-scope" || scopeVersion != "1.2.3" || resourceURL != "https://fixture.invalid/resource" || scopeURL != "https://fixture.invalid/scope" {
			s.t.Errorf("%s log %s identity/time/scope differs", c.Name, body)
		}
		s.checkCompatibilityAttrs(resourceAttrs, "resource")
		s.checkCompatibilityAttrs(attrs, "record")
		s.checkCompatibilityAttrs(scopeAttrs, "scope")
	}
	s.must("read compatibility log rows", rows.Err())
	for body := range expected {
		if seen[body] != 1 {
			s.t.Fatalf("%s log %s multiplicity %d, want 1", c.Name, body, seen[body])
		}
	}
}

func (s *stack) verifyCompatibilitySchema(db *sql.DB) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	for table, columns := range map[string]map[string]string{
		"otel_traces": {
			"Timestamp": "DateTime64(9)", "Duration": "UInt64",
			"Events.Timestamp": "Array(DateTime64(9))", "Events.Name": "Array(LowCardinality(String))",
			"Events.Attributes": "Array(Map(LowCardinality(String), String))",
			"Links.TraceId":     "Array(String)", "Links.SpanId": "Array(String)", "Links.TraceState": "Array(String)",
			"Links.Attributes": "Array(Map(LowCardinality(String), String))",
		},
		"otel_logs": {"Timestamp": "DateTime64(9)", "ScopeAttributes": "Map(LowCardinality(String), String)"},
	} {
		for column, want := range columns {
			var got string
			s.must("inspect compatibility column type", db.QueryRowContext(ctx, `SELECT type FROM system.columns WHERE database = 'logice' AND table = ? AND name = ?`, table, column).Scan(&got))
			if got != want {
				s.t.Errorf("%s.%s type %s, want %s", table, column, got, want)
			}
		}
	}
	for _, column := range []string{"ScopeAttributes", "ResourceSchemaUrl", "ScopeSchemaUrl", "Events.DroppedAttributesCount", "Links.DroppedAttributesCount"} {
		var count uint64
		s.must("inspect unsupported trace field", db.QueryRowContext(ctx, `SELECT count() FROM system.columns WHERE database = 'logice' AND table = 'otel_traces' AND name = ?`, column).Scan(&count))
		if count != 0 {
			s.t.Fatalf("unsupported trace field %s unexpectedly has a column", column)
		}
	}
	for _, column := range []string{"ObservedTimestamp", "ObservedTimeUnixNano"} {
		var count uint64
		s.must("inspect unsupported observed-time field", db.QueryRowContext(ctx, `SELECT count() FROM system.columns WHERE database = 'logice' AND table = 'otel_logs' AND name = ?`, column).Scan(&count))
		if count != 0 {
			s.t.Fatal("unexpected separate observed timestamp column")
		}
	}
}
