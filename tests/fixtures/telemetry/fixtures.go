// Package telemetry supplies finite, deterministic OTLP fixtures for tests.
// It is not an application telemetry generator.
package telemetry

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"time"

	collectorlog "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	logs "go.opentelemetry.io/proto/otlp/logs/v1"
	resource "go.opentelemetry.io/proto/otlp/resource/v1"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
)

type Span struct {
	ID, ParentID string
	Start        time.Time
}
type Log struct {
	Body, TraceID, SpanID string
	Time                  time.Time
}
type Manifest struct {
	TraceID             string
	Spans               []Span
	Logs                []Log
	SpanCount, LogCount int
}
type Case struct {
	Name     string
	Batches  []*collectortrace.ExportTraceServiceRequest
	Logs     *collectorlog.ExportLogsServiceRequest
	Manifest Manifest
}

func text(s string) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_StringValue{StringValue: s}}
}
func attr(k string, v *common.AnyValue) *common.KeyValue { return &common.KeyValue{Key: k, Value: v} }
func integer(n int64) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_IntValue{IntValue: n}}
}
func double(n float64) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_DoubleValue{DoubleValue: n}}
}
func boolean(b bool) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_BoolValue{BoolValue: b}}
}
func array(v ...*common.AnyValue) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_ArrayValue{ArrayValue: &common.ArrayValue{Values: v}}}
}
func mapping(v ...*common.KeyValue) *common.AnyValue {
	return &common.AnyValue{Value: &common.AnyValue_KvlistValue{KvlistValue: &common.KeyValueList{Values: v}}}
}

// Attributes returns new input values. Expected stored values are specified
// independently in the compatibility tests and documentation.
func Attributes() []*common.KeyValue {
	return []*common.KeyValue{
		attr("array", array(text("alpha"), integer(42), boolean(true), double(1.5))),
		attr("nested", mapping(attr("inner", mapping(attr("enabled", boolean(true)))), attr("logice.project.id", text("nested-spoof")))),
		attr("empty", &common.AnyValue{}), attr("empty.array", array()), attr("empty.map", mapping()),
		attr("bytes", &common.AnyValue{Value: &common.AnyValue_BytesValue{BytesValue: []byte{0, 255}}}),
		attr("int.min", integer(math.MinInt64)), attr("int.max", integer(math.MaxInt64)),
		attr("double.max", double(math.MaxFloat64)), attr("double.min", double(math.SmallestNonzeroFloat64)),
		attr("nan", double(math.NaN())), attr("inf", double(math.Inf(1))), attr("negative.inf", double(math.Inf(-1))),
		attr("nested.nan", mapping(attr("value", double(math.NaN())))),
		attr("logice.project.id", mapping(attr("untrusted", array(text("spoof"))))),
	}
}
func spoofAttrs(arraySpoof bool) []*common.KeyValue {
	attrs := Attributes()
	if arraySpoof {
		for _, a := range attrs {
			if a.Key == "logice.project.id" {
				a.Value = array(text("spoof"), mapping(attr("logice.project.id", text("nested-spoof"))))
			}
		}
	}
	return attrs
}
func res(arraySpoof bool) *resource.Resource {
	return &resource.Resource{Attributes: append(spoofAttrs(arraySpoof), attr("service.name", text("deterministic-telemetry")))}
}
func scope() *common.InstrumentationScope {
	return &common.InstrumentationScope{Name: "fixture-scope", Version: "1.2.3", Attributes: Attributes()}
}
func spanID(seed uint32, c, ordinal int) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(seed)<<32|uint64(c)<<16|uint64(ordinal))
	return b
}
func traceID(seed uint32, c int) []byte {
	b := make([]byte, 16)
	binary.BigEndian.PutUint64(b, uint64(seed))
	binary.BigEndian.PutUint64(b[8:], uint64(c))
	return b
}

// Generate uses no clock, global random state, shared protobufs or credentials.
// Seed zero is valid: the nonzero case and ordinal keep every identity nonzero.
func Generate(seed uint32, base time.Time) []Case {
	base = base.UTC()
	specs := []struct {
		name        string
		count, logs int
	}{
		{"deep", 8, 2}, {"wide", 9, 2}, {"orphan", 2, 2}, {"child-before-parent", 2, 2},
		{"later-parent", 2, 2}, {"correlated", 2, 2}, {"uncorrelated", 0, 2}, {"compatibility", 3, 3},
	}
	out := make([]Case, 0, len(specs))
	for index, spec := range specs {
		number := index + 1
		tid := traceID(seed, number)
		c := Case{Name: spec.name, Manifest: Manifest{TraceID: hex.EncodeToString(tid), SpanCount: spec.count, LogCount: spec.logs}}
		spans := make([]*trace.Span, 0, spec.count)
		for n := 1; n <= spec.count; n++ {
			parent := 0
			if n > 1 {
				parent = 1
				if spec.name == "deep" {
					parent = n - 1
				}
				if spec.name == "orphan" {
					parent = 99
				}
			}
			id := spanID(seed, number, n)
			var pid []byte
			if parent > 0 {
				pid = spanID(seed, number, parent)
			}
			start := base.Add(time.Duration(n))
			spans = append(spans, &trace.Span{TraceId: append([]byte(nil), tid...), SpanId: id, ParentSpanId: pid, Name: fmt.Sprintf("%s-%d", spec.name, n),
				StartTimeUnixNano: uint64(start.UnixNano()), EndTimeUnixNano: uint64(start.Add(1234567).UnixNano()), Attributes: spoofAttrs(n%2 == 0),
				Events: []*trace.Span_Event{{TimeUnixNano: uint64(start.Add(7).UnixNano()), Name: "fixture-event", Attributes: Attributes(), DroppedAttributesCount: 2}},
				Links:  []*trace.Span_Link{{TraceId: append([]byte(nil), tid...), SpanId: spanID(seed, number, 1), TraceState: "vendor=value", Attributes: Attributes(), DroppedAttributesCount: 3}},
			})
			c.Manifest.Spans = append(c.Manifest.Spans, Span{hex.EncodeToString(id), hex.EncodeToString(pid), start})
		}
		request := func(records ...*trace.Span) *collectortrace.ExportTraceServiceRequest {
			return &collectortrace.ExportTraceServiceRequest{ResourceSpans: []*trace.ResourceSpans{{Resource: res(number%2 == 0), SchemaUrl: "https://fixture.invalid/resource", ScopeSpans: []*trace.ScopeSpans{{Scope: scope(), SchemaUrl: "https://fixture.invalid/scope", Spans: records}}}}}
		}
		switch spec.name {
		case "later-parent":
			c.Batches = []*collectortrace.ExportTraceServiceRequest{request(spans[1]), request(spans[0])}
		case "child-before-parent":
			c.Batches = []*collectortrace.ExportTraceServiceRequest{request(spans[1], spans[0])}
		default:
			if len(spans) > 0 {
				c.Batches = []*collectortrace.ExportTraceServiceRequest{request(spans...)}
			}
		}
		records := make([]*logs.LogRecord, 0, spec.logs)
		for n := 1; n <= spec.logs; n++ {
			timestamp := base.Add(time.Duration(100 + n))
			body := fmt.Sprintf("%s-log-%d", spec.name, n)
			r := &logs.LogRecord{TimeUnixNano: uint64(timestamp.UnixNano()), ObservedTimeUnixNano: uint64(timestamp.Add(50).UnixNano()), Body: text(body), Attributes: spoofAttrs(n%2 == 0), SeverityText: "INFO", SeverityNumber: logs.SeverityNumber_SEVERITY_NUMBER_INFO, Flags: 1}
			if spec.count > 0 && (n == 1 || spec.name == "correlated") {
				r.TraceId = append([]byte(nil), tid...)
				r.SpanId = spanID(seed, number, spec.count)
			}
			if spec.name == "compatibility" && n == 3 {
				r.TimeUnixNano = 0
				r.ObservedTimeUnixNano = uint64(timestamp.UnixNano())
			}
			records = append(records, r)
			c.Manifest.Logs = append(c.Manifest.Logs, Log{body, hex.EncodeToString(r.TraceId), hex.EncodeToString(r.SpanId), timestamp})
		}
		c.Logs = &collectorlog.ExportLogsServiceRequest{ResourceLogs: []*logs.ResourceLogs{{Resource: res(number%2 != 0), SchemaUrl: "https://fixture.invalid/resource", ScopeLogs: []*logs.ScopeLogs{{Scope: scope(), SchemaUrl: "https://fixture.invalid/scope", LogRecords: records}}}}}
		out = append(out, c)
	}
	return out
}
