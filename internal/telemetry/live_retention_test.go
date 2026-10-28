package telemetry

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLiveRetainTracesSignedNanoseconds(t *testing.T) {
	trace := func(n int) string { return fmt.Sprintf("%032x", n) }
	record := func(n int, ns int64) LiveRecord {
		return LiveRecord{Kind: "span", TraceID: trace(n), SpanID: "0123456789abcdef", latestMatchingNs: ns, StartTime: time.Unix(0, 42)}
	}
	tests := []struct {
		name  string
		spans []LiveRecord
		logs  []LiveRecord
		want  []string
	}{
		{name: "empty", want: []string{}},
		{name: "negative values are present", spans: []LiveRecord{record(1, -2), record(2, -1)}, want: []string{trace(2), trace(1)}},
		{name: "zero is later than negative", spans: []LiveRecord{record(1, -1), record(2, 0)}, want: []string{trace(2), trace(1)}},
		{name: "signed extremes and adjacent values", spans: []LiveRecord{record(1, math.MinInt64), record(2, math.MaxInt64), record(3, math.MaxInt64-1), record(4, math.MinInt64+1), record(5, 0)}, want: []string{trace(2), trace(3), trace(5), trace(4), trace(1)}},
		{name: "maximum across spans regardless of record order", spans: []LiveRecord{record(1, 3), record(2, 2), record(1, -3), record(2, 1)}, want: []string{trace(1), trace(2)}},
		{name: "ascending trace ID breaks ties", spans: []LiveRecord{record(3, -1), record(1, -1), record(2, -1)}, want: []string{trace(1), trace(2), trace(3)}},
		{name: "minimum int64 is a real timestamp", spans: []LiveRecord{record(2, math.MinInt64), record(1, math.MinInt64)}, want: []string{trace(1), trace(2)}},
		{name: "maximum across spans and logs", spans: []LiveRecord{record(1, -3), record(2, -2)}, logs: []LiveRecord{{Kind: "log", TraceID: trace(1), latestMatchingNs: -1}, {Kind: "log", TraceID: trace(2), latestMatchingNs: math.MinInt64}}, want: []string{trace(1), trace(2)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := LiveSnapshot{Spans: tt.spans, Logs: tt.logs}
			if got := liveRetainTraces(&r); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("traces = %v, want %v", got, tt.want)
			}
			if r.TraceGroupsTruncated || !reflect.DeepEqual(r.Spans, append([]LiveRecord{}, tt.spans...)) || !reflect.DeepEqual(r.Logs, append([]LiveRecord{}, tt.logs...)) {
				t.Fatalf("unexpected truncation or record filtering: %#v", r)
			}
		})
	}
}

func TestLiveRetainTracesCapAndMalformedRecords(t *testing.T) {
	r := LiveSnapshot{}
	wantTraces := []string{}
	wantSpans := []LiveRecord{}
	wantLogs := []LiveRecord{}
	// Insert in reverse ID order. All groups tie at the minimum timestamp.
	for i := LiveTraceGroupLimit + 1; i >= 1; i-- {
		trace := fmt.Sprintf("%032x", i)
		span := LiveRecord{ID: fmt.Sprintf("span-%d", i), Kind: "span", TraceID: trace, SpanID: "0123456789abcdef", latestMatchingNs: math.MinInt64}
		log := LiveRecord{ID: fmt.Sprintf("log-%d", i), Kind: "log", TraceID: trace, latestMatchingNs: math.MinInt64}
		r.Spans = append(r.Spans, span)
		r.Logs = append(r.Logs, log)
		if i <= LiveTraceGroupLimit {
			wantSpans = append(wantSpans, span)
			wantLogs = append(wantLogs, log)
		}
	}
	for i := 1; i <= LiveTraceGroupLimit; i++ {
		wantTraces = append(wantTraces, fmt.Sprintf("%032x", i))
	}
	malformedSpans := []LiveRecord{
		{ID: "missing-trace", Kind: "span", SpanID: "0123456789abcdef"},
		{ID: "malformed-trace", Kind: "span", TraceID: "bad", SpanID: "0123456789abcdef"},
		{ID: "zero-trace", Kind: "span", TraceID: strings.Repeat("0", 32), SpanID: "0123456789abcdef"},
		{ID: "missing-span", Kind: "span", TraceID: strings.Repeat("f", 32)},
		{ID: "malformed-span", Kind: "span", TraceID: strings.Repeat("f", 32), SpanID: "bad"},
		{ID: "zero-span", Kind: "span", TraceID: strings.Repeat("f", 32), SpanID: strings.Repeat("0", 16)},
	}
	malformedLogs := []LiveRecord{
		{ID: "uncorrelated", Kind: "log"},
		{ID: "malformed-trace", Kind: "log", TraceID: "bad"},
		{ID: "zero-trace", Kind: "log", TraceID: strings.Repeat("0", 32)},
	}
	// These records must remain, but must not add or promote a trace group.
	for i := range malformedSpans {
		malformedSpans[i].latestMatchingNs = math.MaxInt64
	}
	for i := range malformedLogs {
		malformedLogs[i].latestMatchingNs = math.MaxInt64
	}
	r.Spans = append(r.Spans, malformedSpans...)
	r.Logs = append(r.Logs, malformedLogs...)
	wantSpans = append(wantSpans, malformedSpans...)
	wantLogs = append(wantLogs, malformedLogs...)
	if got := liveRetainTraces(&r); !reflect.DeepEqual(got, wantTraces) {
		t.Fatalf("retained traces = %v, want %v", got, wantTraces)
	}
	if !r.TraceGroupsTruncated || !reflect.DeepEqual(r.Spans, wantSpans) || !reflect.DeepEqual(r.Logs, wantLogs) {
		t.Fatal("trace cap, record order, or malformed retention changed")
	}
}
