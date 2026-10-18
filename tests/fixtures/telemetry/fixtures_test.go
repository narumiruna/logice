package telemetry_test

import (
	"encoding/hex"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	fixture "github.com/narumiruna/logice/tests/fixtures/telemetry"
	"google.golang.org/protobuf/proto"
)

func TestMatrixOracle(t *testing.T) {
	base := time.Date(2026, 10, 18, 1, 2, 3, 456789123, time.UTC)
	cases := fixture.Generate(7, base)
	oracle := []struct {
		name, traceSuffix, ids, parents string
		batches                         [][]int
		logs                            int
		correlated                      []bool
	}{
		{"deep", "01", "00010001 00010002 00010003 00010004 00010005 00010006 00010007 00010008", "- 00010001 00010002 00010003 00010004 00010005 00010006 00010007", [][]int{{1, 2, 3, 4, 5, 6, 7, 8}}, 2, []bool{true, false}},
		{"wide", "02", "00020001 00020002 00020003 00020004 00020005 00020006 00020007 00020008 00020009", "- 00020001 00020001 00020001 00020001 00020001 00020001 00020001 00020001", [][]int{{1, 2, 3, 4, 5, 6, 7, 8, 9}}, 2, []bool{true, false}},
		{"orphan", "03", "00030001 00030002", "- 00030063", [][]int{{1, 2}}, 2, []bool{true, false}},
		{"child-before-parent", "04", "00040001 00040002", "- 00040001", [][]int{{2, 1}}, 2, []bool{true, false}},
		{"later-parent", "05", "00050001 00050002", "- 00050001", [][]int{{2}, {1}}, 2, []bool{true, false}},
		{"correlated", "06", "00060001 00060002", "- 00060001", [][]int{{1, 2}}, 2, []bool{true, true}},
		{"uncorrelated", "07", "", "", nil, 2, []bool{false, false}},
		{"compatibility", "08", "00080001 00080002 00080003", "- 00080001 00080001", [][]int{{1, 2, 3}}, 3, []bool{true, false, false}},
	}
	if len(cases) != len(oracle) {
		t.Fatalf("cases=%d", len(cases))
	}
	for i, want := range oracle {
		t.Run(want.name, func(t *testing.T) {
			got := cases[i]
			ids := strings.Fields(want.ids)
			parents := strings.Fields(want.parents)
			traceID := "000000000000000700000000000000" + want.traceSuffix
			if got.Name != want.name || got.Manifest.TraceID != traceID || got.Manifest.SpanCount != len(ids) || got.Manifest.LogCount != want.logs || len(got.Manifest.Spans) != len(ids) || len(got.Manifest.Logs) != want.logs {
				t.Fatal("manifest count, case or trace identity differs from explicit oracle")
			}
			if len(ids) > 128 || want.logs > 128 {
				t.Fatal("case exceeds finite bound")
			}
			if len(got.Batches) != len(want.batches) {
				t.Fatal("batch count differs")
			}
			for batch, order := range want.batches {
				spans := got.Batches[batch].ResourceSpans[0].ScopeSpans[0].Spans
				if len(spans) != len(order) {
					t.Fatal("batch size differs")
				}
				for j, ordinal := range order {
					k := ordinal - 1
					expectedID := "00000007" + ids[k]
					expectedParent := ""
					if parents[k] != "-" {
						expectedParent = "00000007" + parents[k]
					}
					span := spans[j]
					manifest := got.Manifest.Spans[k]
					start := base.Add(time.Duration(ordinal))
					if hex.EncodeToString(span.TraceId) != traceID || hex.EncodeToString(span.SpanId) != expectedID || hex.EncodeToString(span.ParentSpanId) != expectedParent || manifest.ID != expectedID || manifest.ParentID != expectedParent || !manifest.Start.Equal(start) || span.StartTimeUnixNano != uint64(start.UnixNano()) || span.EndTimeUnixNano-span.StartTimeUnixNano != 1234567 {
						t.Fatalf("batch %d ordinal %d differs from identity/relationship/time oracle", batch, ordinal)
					}
					if span.Name != fmt.Sprintf("%s-%d", want.name, ordinal) || len(span.SpanId) != 8 || len(span.TraceId) != 16 || strings.Trim(hex.EncodeToString(span.SpanId), "0") == "" {
						t.Fatal("invalid identity or name")
					}
				}
			}
			records := got.Logs.ResourceLogs[0].ScopeLogs[0].LogRecords
			if len(records) != want.logs {
				t.Fatal("log count differs")
			}
			for j, r := range records {
				expectedTrace, expectedSpan := "", ""
				if want.correlated[j] {
					expectedTrace = traceID
					expectedSpan = "00000007" + ids[len(ids)-1]
				}
				expectedTime := base.Add(time.Duration(101 + j))
				timestamp := r.TimeUnixNano
				if want.name == "compatibility" && j == 2 {
					if timestamp != 0 {
						t.Fatal("missing observed-time fallback")
					}
					timestamp = r.ObservedTimeUnixNano
				}
				body := fmt.Sprintf("%s-log-%d", want.name, j+1)
				expected := fixture.Log{Body: body, TraceID: expectedTrace, SpanID: expectedSpan, Time: expectedTime}
				if got.Manifest.Logs[j] != expected || r.Body.GetStringValue() != body || hex.EncodeToString(r.TraceId) != expectedTrace || hex.EncodeToString(r.SpanId) != expectedSpan || timestamp != uint64(expectedTime.UnixNano()) {
					t.Fatalf("log %d differs from explicit association/time oracle", j+1)
				}
			}
		})
	}
}

func TestDeterminismAndOwnership(t *testing.T) {
	base := time.Date(2026, 10, 18, 0, 0, 0, 123456789, time.UTC)
	first, second := fixture.Generate(7, base), fixture.Generate(7, base)
	for i := range first {
		if !reflect.DeepEqual(first[i].Manifest, second[i].Manifest) || !proto.Equal(first[i].Logs, second[i].Logs) {
			t.Fatal("same input changed semantics")
		}
		for j := range first[i].Batches {
			if !proto.Equal(first[i].Batches[j], second[i].Batches[j]) {
				t.Fatal("trace differs")
			}
		}
	}
	savedLog := proto.Clone(first[0].Logs)
	savedTrace := proto.Clone(first[0].Batches[0])
	_ = fixture.Generate(8, base.Add(time.Hour))
	second[0].Logs.ResourceLogs[0].ScopeLogs[0].LogRecords[0].TraceId[0] ^= 255
	second[0].Batches[0].ResourceSpans[0].ScopeSpans[0].Spans[0].Name = "mutated"
	second[0].Manifest.Spans[0].ID = "mutated"
	// Even records in one fixture must not share nested values or ID bytes.
	rs := first[1].Batches[0].ResourceSpans[0]
	ss := rs.ScopeSpans[0]
	unchanged := []proto.Message{ss.Spans[1], rs.Resource, ss.Scope, ss.Spans[0].Events[0], ss.Spans[0].Links[0], first[1].Logs}
	saved := make([]proto.Message, len(unchanged))
	for i, message := range unchanged {
		saved[i] = proto.Clone(message)
	}
	ss.Spans[0].Attributes[0].Key = "mutated"
	ss.Spans[0].Attributes[0].Value.GetArrayValue().Values[1].Value = nil
	ss.Spans[0].TraceId[0] ^= 255
	ss.Spans[0].SpanId[0] ^= 255
	for i, message := range unchanged {
		if !proto.Equal(message, saved[i]) {
			t.Fatalf("within-case mutation changed sibling/resource/scope/event/link/log message %d", i)
		}
	}
	if !proto.Equal(first[0].Logs, savedLog) || !proto.Equal(first[0].Batches[0], savedTrace) || first[0].Manifest.Spans[0].ID != "0000000700010001" {
		t.Fatal("generation or mutation changed a previously generated message")
	}
	changed := fixture.Generate(8, base)
	shifted := fixture.Generate(7, base.Add(time.Nanosecond))
	if changed[0].Manifest.TraceID == first[0].Manifest.TraceID || shifted[0].Manifest.TraceID != first[0].Manifest.TraceID || !shifted[0].Manifest.Spans[0].Start.Equal(base.Add(2*time.Nanosecond)) {
		t.Fatal("seed/base independence differs")
	}
	for _, c := range fixture.Generate(0, base) {
		if strings.Trim(c.Manifest.TraceID, "0") == "" {
			t.Fatal("zero trace ID")
		}
		for _, s := range c.Manifest.Spans {
			if strings.Trim(s.ID, "0") == "" {
				t.Fatal("zero span ID")
			}
		}
	}
}

func TestCompatibilityInput(t *testing.T) {
	attrs := fixture.Attributes()
	byKey := map[string]int{}
	for i, a := range attrs {
		byKey[a.Key] = i
	}
	if len(attrs) != 15 || len(byKey) != 15 {
		t.Fatal("compatibility attributes missing or duplicated")
	}
	get := func(key string) int {
		i, ok := byKey[key]
		if !ok {
			t.Fatalf("missing %s", key)
		}
		return i
	}
	if attrs[get("int.min")].Value.GetIntValue() != math.MinInt64 || attrs[get("int.max")].Value.GetIntValue() != math.MaxInt64 || attrs[get("double.max")].Value.GetDoubleValue() != math.MaxFloat64 || attrs[get("double.min")].Value.GetDoubleValue() != math.SmallestNonzeroFloat64 || !math.IsNaN(attrs[get("nan")].Value.GetDoubleValue()) || !math.IsInf(attrs[get("inf")].Value.GetDoubleValue(), 1) || !math.IsInf(attrs[get("negative.inf")].Value.GetDoubleValue(), -1) {
		t.Fatal("numeric boundary input differs")
	}
	c := fixture.Generate(7, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC))[7]
	rs := c.Batches[0].ResourceSpans[0]
	rl := c.Logs.ResourceLogs[0]
	project := get("logice.project.id")
	if len(rs.Resource.Attributes[project].Value.GetArrayValue().Values) != 2 || len(rl.Resource.Attributes[project].Value.GetKvlistValue().Values) != 1 || len(rs.ScopeSpans[0].Spans[1].Attributes[project].Value.GetArrayValue().Values) != 2 || len(rl.ScopeLogs[0].LogRecords[1].Attributes[project].Value.GetArrayValue().Values) != 2 {
		t.Fatal("resource/record map and array spoof variants missing")
	}
	for i, span := range rs.ScopeSpans[0].Spans {
		if len(span.Events) != 1 || span.Events[0].Name != "fixture-event" || span.Events[0].TimeUnixNano != span.StartTimeUnixNano+7 || span.Events[0].DroppedAttributesCount != 2 || len(span.Links) != 1 || hex.EncodeToString(span.Links[0].TraceId) != "00000000000000070000000000000008" || hex.EncodeToString(span.Links[0].SpanId) != "0000000700080001" || span.Links[0].TraceState != "vendor=value" || span.Links[0].DroppedAttributesCount != 3 {
			t.Fatalf("span %d event/link input differs", i+1)
		}
	}
	if rs.ScopeSpans[0].Scope.Name != "fixture-scope" || rs.ScopeSpans[0].Scope.Version != "1.2.3" || len(rs.ScopeSpans[0].Scope.Attributes) != 15 || rl.ScopeLogs[0].SchemaUrl != "https://fixture.invalid/scope" || rl.SchemaUrl != "https://fixture.invalid/resource" {
		t.Fatal("instrumentation scope/schema input differs")
	}
	if len(attrs[get("array")].Value.GetArrayValue().Values) != 4 || len(attrs[get("nested")].Value.GetKvlistValue().Values) != 2 || attrs[get("empty")].Value.Value != nil || len(attrs[get("empty.array")].Value.GetArrayValue().Values) != 0 || len(attrs[get("empty.map")].Value.GetKvlistValue().Values) != 0 || !reflect.DeepEqual(attrs[get("bytes")].Value.GetBytesValue(), []byte{0, 255}) {
		t.Fatal("structured input differs")
	}
}
