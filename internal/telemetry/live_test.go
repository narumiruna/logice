package telemetry

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

func liveTestFilter() LiveFilter {
	return LiveFilter{From: testFilter().From, To: testFilter().From.Add(time.Minute + time.Nanosecond)}
}

func TestLiveBoundsAndFixture(t *testing.T) {
	f := liveTestFilter()
	for _, d := range []time.Duration{time.Second, 15 * time.Minute} {
		f.To = f.From.Add(d)
		if err := f.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []time.Duration{time.Second - 1, 15*time.Minute + 1} {
		f.To = f.From.Add(d)
		if err := f.Validate(); err == nil {
			t.Fatal("invalid storage bound")
		}
	}
	data, err := os.ReadFile("../../tests/fixtures/live/empty.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture LiveSnapshot
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	expected := NewLiveSnapshot(LiveFilter{From: fixture.Window.From, To: fixture.Window.To}, fixture.QueriedAt)
	if !reflect.DeepEqual(fixture, expected) {
		t.Fatal("contract fixture differs from DTO")
	}
	f = liveTestFilter()
	r := NewLiveSnapshot(f, time.Now())
	if len(r.Histogram) != 60 || !r.Histogram[0].From.Equal(f.From) || !r.Histogram[59].To.Equal(f.To) {
		t.Fatal("bad histogram bounds")
	}
	for i, b := range r.Histogram {
		if !b.From.Before(b.To) || b.Spans != "0" || b.Logs != "0" {
			t.Fatal("bad bucket")
		}
		if i > 0 && !r.Histogram[i-1].To.Equal(b.From) {
			t.Fatal("bucket gap")
		}
	}
}

func liveTestPayload(t *testing.T, logs bool, overrides map[string]any) string {
	t.Helper()
	cols := liveSpanColumns
	if logs {
		cols = liveLogColumns
	}
	values := make([]any, len(cols))
	defaults := map[string]any{"Timestamp": fmt.Sprint(liveTestFilter().From.UnixNano()), "TraceId": traceID, "SpanId": "0123456789abcdef", "Duration": "18446744073709551615", "TraceFlags": 1, "SeverityNumber": 17, "ResourceAttributes": [][2]string{{"logice.project.id", "validation"}}, "ScopeAttributes": [][2]string{}, "SpanAttributes": [][2]string{}, "LogAttributes": [][2]string{}, "Events.Timestamp": []string{}, "Events.Name": []string{}, "Events.Attributes": []any{}, "Links.TraceId": []string{}, "Links.SpanId": []string{}, "Links.TraceState": []string{}, "Links.Attributes": []any{}}
	for i, c := range cols {
		v, ok := overrides[c]
		if !ok {
			v, ok = defaults[c]
		}
		if !ok {
			v = ""
		}
		values[i] = v
	}
	raw, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestLiveFullStoredIdentity(t *testing.T) {
	payload := liveTestPayload(t, true, map[string]any{"Body": "a|b:c\x00<>", "ScopeName": "scope", "ScopeVersion": "v1", "EventName": "event", "ScopeAttributes": [][2]string{{"x", "y"}, {"x", "z"}}})
	r, err := liveDecode(payload, true)
	if err != nil {
		t.Fatal(err)
	}
	if r.TraceFlags != 1 || r.ScopeName != "scope" || r.ScopeAttributes["x"] != "z" || r.SeverityNumber != 17 || len(r.Stored) != len(liveLogColumns) {
		t.Fatal("lost stored metadata")
	}
	original := liveIdentity(r, payload)
	for _, column := range liveLogColumns {
		if column == "Timestamp" || column == "TraceFlags" || column == "SeverityNumber" || strings.HasSuffix(column, "Attributes") {
			continue
		}
		changed := liveTestPayload(t, true, map[string]any{column: "different"})
		other, err := liveDecode(changed, true)
		if err != nil {
			t.Fatal(err)
		}
		if liveIdentity(other, changed) == original {
			t.Fatalf("identity omitted %s", column)
		}
	}
	for _, ids := range []map[string]any{{"TraceId": "bad", "SpanId": "0123456789abcdef"}, {"TraceId": traceID, "SpanId": "bad"}, {"TraceId": strings.Repeat("0", 32)}} {
		p := liveTestPayload(t, false, ids)
		r, err := liveDecode(p, false)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(liveIdentity(r, p), "span-content:v1:") {
			t.Fatal("malformed ID became linkable")
		}
	}
	span := liveTestPayload(t, false, map[string]any{"TraceId": strings.ToUpper(traceID)})
	r, err = liveDecode(span, false)
	if err != nil || r.DurationNs != "18446744073709551615" || liveIdentity(r, span) != "span:validation:"+traceID+":0123456789abcdef" {
		t.Fatal("span identity/duration lost")
	}
}

func TestLiveQueryPredicatesAndBounds(t *testing.T) {
	f := liveTestFilter()
	f.Service = "' OR 1=1"
	f.Search = "%_MiXeD"
	f.ErrorsOnly = true
	f.MinSeverity = 9
	for _, logs := range []bool{false, true} {
		q, args := liveMatchingQuery(f, logs)
		if strings.Contains(q, f.Service) || strings.Contains(q, f.Search) || !strings.Contains(q, scope) || !strings.Contains(q, "positionCaseInsensitiveUTF8(SpanId") || strings.Index(q, "GROUP BY") > strings.Index(q, "LIMIT 501") {
			t.Fatal("unbounded/unparameterized query")
		}
		if !reflect.DeepEqual(args[len(args)-2:], []any{f.From.UnixNano(), f.To.UnixNano()}) {
			t.Fatal("wrong time args")
		}
		histogram, hargs := liveHistogramQuery(f, logs)
		if !strings.Contains(histogram, scope) || !strings.Contains(histogram, "toInt128") || strings.Contains(histogram, "LIMIT") {
			t.Fatal("histogram lost scope/counts")
		}
		if logs && hargs[len(hargs)-3] != 17 {
			t.Fatal("error severity threshold not combined")
		}
	}
	q, args := liveContextQuery(f, []string{traceID}, []LiveRecord{{ID: "id", Kind: "span", TraceID: traceID, ParentSpanID: "0123456789abcdef"}})
	if strings.Contains(q, "positionCaseInsensitive") || strings.Contains(q, "ServiceName =") || !strings.Contains(q, "PARTITION BY traceGroup") || !strings.Contains(q, "LIMIT 501") || len(args) != 6 {
		t.Fatal("context not fair/bounded")
	}
}

func TestLiveSharedBudgetAndComponentFailures(t *testing.T) {
	f := liveTestFilter()
	var cancellations []<-chan struct{}
	calls := 0
	store := testStore(t, func(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
		calls++
		if ctx.Done() == nil {
			t.Fatal("no shared cancellation")
		}
		if _, ok := ctx.Deadline(); ok {
			t.Fatal("driver would replace the server execution limit")
		}
		cancellations = append(cancellations, ctx.Done())
		return rows(), nil
	})
	result, err := store.Live(context.Background(), f)
	if err != nil || len(result.Histogram) != 60 || calls != 4 {
		t.Fatalf("empty live %d %v", calls, err)
	}
	for _, done := range cancellations {
		if done != cancellations[0] {
			t.Fatal("components restart cancellation budget")
		}
	}
	for _, failure := range []error{errors.New("Code:60"), &clickhouse.Exception{Code: 516}, context.DeadlineExceeded} {
		calls = 0
		failed := testStore(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
			calls++
			if calls == 3 {
				return nil, failure
			}
			return rows(), nil
		})
		got, err := failed.Live(context.Background(), f)
		if err == nil || got.Histogram != nil {
			t.Fatal("partial success")
		}
	}
	missing := testStore(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
		return nil, &clickhouse.Exception{Code: 60}
	})
	if _, err = missing.Live(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	calls = 0
	if _, err = store.Live(context.Background(), LiveFilter{}); err == nil || calls != 0 {
		t.Fatal("invalid filter reached database")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = store.Live(ctx, f); err == nil {
		t.Fatal("cancellation ignored")
	}
}

func TestLiveCollisionAndStoredRead(t *testing.T) {
	p := liveTestPayload(t, true, nil)
	r, err := liveDecode(p, true)
	if err != nil {
		t.Fatal(err)
	}
	id := liveIdentity(r, p)
	q, args := liveMatchingQuery(liveTestFilter(), true)
	for _, invalid := range []bool{false, true} {
		store := testStore(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
			first := []driver.Value{id, p, int64(3), false, false, liveTestFilter().From.UnixNano()}
			if invalid {
				second := append([]driver.Value{}, first...)
				second[1] = liveTestPayload(t, true, map[string]any{"ScopeName": "other"})
				return rows(first, second), nil
			}
			return rows(first), nil
		})
		result, err := store.liveRecords(context.Background(), q, args, true, false)
		if invalid {
			if err == nil {
				t.Fatal("digest collision merged")
			}
			continue
		}
		if err != nil || len(result) != 1 || result[0].Occurrences != "3" {
			t.Fatal("lost occurrence count")
		}
	}
}

func TestLiveEpochZeroTracePriority(t *testing.T) {
	r := NewLiveSnapshot(liveTestFilter(), time.Now())
	r.Spans = append(r.Spans, LiveRecord{ID: "epoch", Kind: "span", TraceID: strings.Repeat("f", 32), SpanID: "0123456789abcdef", StartTime: time.Unix(0, -500000000), latestMatchingNs: 0})
	for i := 0; i < 100; i++ {
		r.Spans = append(r.Spans, LiveRecord{ID: fmt.Sprint(i), Kind: "span", TraceID: fmt.Sprintf("%032x", i+1), SpanID: "0123456789abcdef", StartTime: time.Unix(0, -100000000), latestMatchingNs: -100000000})
	}
	traces := liveRetainTraces(&r)
	if len(traces) != 100 || traces[0] != strings.Repeat("f", 32) {
		t.Fatal("Unix epoch zero lost newest trace priority")
	}
}

func TestLiveAncestorPathsAndGroups(t *testing.T) {
	f := liveTestFilter()
	r := NewLiveSnapshot(f, time.Now())
	for i := 0; i < 101; i++ {
		r.Spans = append(r.Spans, LiveRecord{ID: fmt.Sprint(i), Kind: "span", TraceID: fmt.Sprintf("%032x", i+1), SpanID: "0123456789abcdef", StartTime: f.From.Add(time.Duration(i))})
	}
	r.Logs = append(r.Logs, LiveRecord{ID: "uncorrelated", Kind: "log"})
	traces := liveRetainTraces(&r)
	if len(traces) != 100 || len(r.Spans) != 100 || len(r.Logs) != 1 || !r.TraceGroupsTruncated {
		t.Fatal("trace group cap")
	}
	parent := LiveRecord{ID: "parent", Kind: "span", TraceID: traceID, SpanID: "0000000000000001", ParentSpanID: "0000000000000002"}
	root := LiveRecord{ID: "root", Kind: "span", TraceID: traceID, SpanID: "0000000000000002"}
	unrelated := LiveRecord{ID: "other", Kind: "span", TraceID: traceID, SpanID: "0000000000000003"}
	child := LiveRecord{ID: "child", Kind: "span", TraceID: traceID, SpanID: "0000000000000004", ParentSpanID: parent.SpanID}
	if got := liveAncestors([]LiveRecord{root, parent, unrelated}, []LiveRecord{child}); len(got) != 2 {
		t.Fatal("lost ancestor path")
	}
	child.ParentConflict = true
	if got := liveAncestors([]LiveRecord{root, parent}, []LiveRecord{child}); len(got) != 0 {
		t.Fatal("ambiguous edge retained")
	}
	parent.ParentSpanID = parent.SpanID
	if got := liveAncestors([]LiveRecord{parent}, []LiveRecord{{Kind: "log", TraceID: traceID, SpanID: parent.SpanID}}); len(got) != 1 {
		t.Fatal("cycle traversal")
	}
}
