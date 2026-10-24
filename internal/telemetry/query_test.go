package telemetry

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

const traceID = "0123456789abcdef0123456789abcdef"

func testFilter() Filter {
	from := time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC)
	return Filter{From: from, To: from.Add(time.Hour), project: "validation"}
}

func TestQueriesScopeAndParameters(t *testing.T) {
	f := testFilter()
	f.To = f.From.Add(time.Nanosecond)
	f.Service = "service' OR 1=1 --"
	f.Search = "%_' OR 1=1 --"
	f.TraceID = strings.ToUpper(traceID)
	f.ErrorsOnly = true
	f.MinSeverity = 17
	f.Limit = 1

	for name, builder := range map[string]func() (string, []any){
		"traces": func() (string, []any) { return tracesQuery(f) },
		"spans":  func() (string, []any) { return spansQuery(f) },
		"logs":   func() (string, []any) { return logsQuery(f, 200) },
	} {
		t.Run(name, func(t *testing.T) {
			query, args := builder()
			for _, required := range []string{"ResourceAttributes['logice.project.id'] = ?", "toUnixTimestamp64Nano(Timestamp) >= ?", "toUnixTimestamp64Nano(Timestamp) < ?", "ServiceName = ?", "TraceId = ?", "LIMIT ?"} {
				if !strings.Contains(query, required) {
					t.Fatalf("missing %q in %s", required, query)
				}
			}
			if strings.Contains(query, f.Service) || strings.Contains(query, f.Search) || strings.Contains(query, traceID) {
				t.Fatalf("user value interpolated into SQL: %s", query)
			}
			if strings.Count(query, "?") != len(args) {
				t.Fatalf("placeholders do not match args: %s, %#v", query, args)
			}
			if args[0] != f.project || args[1] != f.From.UnixNano() || args[2] != f.To.UnixNano() || args[3] != f.Service {
				t.Fatalf("bounds or service parameters = %#v", args)
			}
			for _, arg := range args {
				if _, ok := arg.(time.Time); ok {
					t.Fatal("datetime parameter can lose nanosecond precision")
				}
			}
		})
	}
	query, args := tracesQuery(f)
	want := []any{f.project, f.From.UnixNano(), f.To.UnixNano(), f.Service, f.Search, f.Search, traceID, "Error", 2}
	if !reflect.DeepEqual(args, want) || !strings.Contains(query, "HAVING countIf(StatusCode = ?) > 0") || strings.Contains(query, "AND StatusCode =") {
		t.Fatalf("error trace grouping: %s, %#v", query, args)
	}
	for _, required := range []string{"toInt128(Duration)", "min(toInt128(toUnixTimestamp64Nano(Timestamp)))", "tuple(ParentSpanId != '', Timestamp, SpanId)", "countIf(StatusCode = 'Error')"} {
		if !strings.Contains(query, required) {
			t.Fatalf("unsafe or incorrect summary, missing %s: %s", required, query)
		}
	}
	query, args = logsQuery(f, 200)
	want = []any{f.project, f.From.UnixNano(), f.To.UnixNano(), f.Service, f.Search, 17, traceID, 201}
	if !reflect.DeepEqual(args, want) || !strings.Contains(query, "position(Body, ?) > 0") || strings.Contains(query, "LIKE") {
		t.Fatalf("literal log search: %s, %#v", query, args)
	}
	_, args = spansQuery(f)
	if args[len(args)-1] != 501 {
		t.Fatalf("span hard cap: %#v", args)
	}
	_, args = tracesQuery(testFilter())
	if args[len(args)-1] != 51 {
		t.Fatalf("default list cap: %#v", args)
	}
}

func TestFilterValidation(t *testing.T) {
	for name, change := range map[string]func(*Filter){
		"missing from":    func(f *Filter) { f.From = time.Time{} },
		"missing to":      func(f *Filter) { f.To = time.Time{} },
		"equal":           func(f *Filter) { f.To = f.From },
		"reversed":        func(f *Filter) { f.To = f.From.Add(-time.Second) },
		"long range":      func(f *Filter) { f.To = f.From.Add(24*time.Hour + time.Nanosecond) },
		"early timestamp": func(f *Filter) { f.From = time.Date(1, 1, 1, 1, 0, 0, 0, time.UTC); f.To = f.From.Add(time.Hour) },
		"late timestamp":  func(f *Filter) { f.From = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC); f.To = f.From.Add(time.Hour) },
		"long service":    func(f *Filter) { f.Service = strings.Repeat("a", 201) },
		"long search":     func(f *Filter) { f.Search = strings.Repeat("é", 101) },
		"negative limit":  func(f *Filter) { f.Limit = -1 },
		"large limit":     func(f *Filter) { f.Limit = 101 },
		"low severity":    func(f *Filter) { f.MinSeverity = -1 },
		"high severity":   func(f *Filter) { f.MinSeverity = 25 },
		"short ID":        func(f *Filter) { f.TraceID = "1234" },
		"zero ID":         func(f *Filter) { f.TraceID = strings.Repeat("0", 32) },
		"nonhex ID":       func(f *Filter) { f.TraceID = strings.Repeat("z", 32) },
	} {
		t.Run(name, func(t *testing.T) {
			f := testFilter()
			change(&f)
			if f.Validate() == nil {
				t.Fatalf("invalid filter accepted: %+v", f)
			}
		})
	}
	f := testFilter()
	f.To = f.From.Add(24 * time.Hour)
	f.Service, f.Search = strings.Repeat("a", 200), strings.Repeat("é", 100)
	f.TraceID, f.Limit, f.MinSeverity = strings.ToUpper(traceID), 100, 24
	if err := f.Validate(); err != nil {
		t.Fatalf("valid boundary filter: %v", err)
	}
}

func TestNanoTimeSafeArithmetic(t *testing.T) {
	for value, want := range map[string]time.Time{
		"1767225600123456789":  testFilter().From,
		"-1":                   time.Unix(0, -1),
		"27670116110564327422": time.Unix(27670116110, 564327422),
	} {
		got, err := nanoTime(value)
		if err != nil || !got.Equal(want) {
			t.Fatalf("nanoTime(%q) = %v, %v; want %v", value, got, err, want)
		}
	}
	for _, value := range []string{"bad", "9999999999999999999999999999999999999999", "9999999999999999999999"} {
		if _, err := nanoTime(value); err == nil {
			t.Fatalf("invalid nano time %q accepted", value)
		}
	}
}
