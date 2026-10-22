package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

const testTraceID = "0123456789abcdef0123456789abcdef"

type fakeReader struct {
	traces func(context.Context, telemetry.Filter) (telemetry.TraceList, error)
	logs   func(context.Context, telemetry.Filter) (telemetry.LogList, error)
	trace  func(context.Context, string, telemetry.Filter) (telemetry.TraceDetail, error)
}

func (f fakeReader) Traces(ctx context.Context, filter telemetry.Filter) (telemetry.TraceList, error) {
	if f.traces != nil {
		return f.traces(ctx, filter)
	}
	return telemetry.TraceList{}, nil
}

func (f fakeReader) Logs(ctx context.Context, filter telemetry.Filter) (telemetry.LogList, error) {
	if f.logs != nil {
		return f.logs(ctx, filter)
	}
	return telemetry.LogList{}, nil
}

func (f fakeReader) Trace(ctx context.Context, id string, filter telemetry.Filter) (telemetry.TraceDetail, error) {
	if f.trace != nil {
		return f.trace(ctx, id, filter)
	}
	return telemetry.TraceDetail{TraceID: id}, nil
}

func TestQueryValidation(t *testing.T) {
	from := "2026-01-01T00:00:00.123456789Z"
	to := "2026-01-01T01:00:00.123456789Z"
	bounds := "from=" + from + "&to=" + to
	cases := []struct{ route, query string }{
		{"traces", "from=" + from},
		{"traces", "to=" + to},
		{"traces", "from=&to="},
		{"traces", "from=no&to=" + to},
		{"traces", "from=" + from + "&to=no"},
		{"traces", "from=" + from + "&to=" + from},
		{"traces", "from=" + to + "&to=" + from},
		{"traces", "from=" + from + "&to=2026-01-02T00:00:00.123456790Z"},
		{"traces", "from=0001-01-01T00:00:00Z&to=0001-01-01T01:00:00Z"},
		{"traces", "from=9999-01-01T00:00:00Z&to=9999-01-01T01:00:00Z"},
		{"traces", bounds + "&from=" + from},
		{"traces", "service=a&service=b"},
		{"traces", "limit=1&limit=2"},
		{"traces", "project=other"},
		{"traces", "unknown="},
		{"traces", "limit=0"},
		{"traces", "limit=-1"},
		{"traces", "limit=101"},
		{"traces", "limit=one"},
		{"traces", "errorsOnly=perhaps"},
		{"traces", "minSeverity=1"},
		{"traces", "traceId=" + testTraceID},
		{"traces", "service=" + strings.Repeat("a", 201)},
		{"logs", "search=" + url.QueryEscape(strings.Repeat("é", 101))},
		{"logs", "errorsOnly=true"},
		{"logs", "minSeverity=-1"},
		{"logs", "minSeverity=25"},
		{"logs", "minSeverity=x"},
		{"logs", "minSeverity="},
		{"logs", "traceId="},
		{"logs", "traceId=123"},
		{"logs", "traceId=" + strings.Repeat("0", 32)},
		{"logs", "traceId=" + strings.Repeat("g", 32)},
		{"detail", "limit=1"},
		{"detail", "service=test"},
		{"detail", "traceId=" + testTraceID},
		{"detail", "errorsOnly=false"},
		{"logs", "search=%zz"},
		{"logs", "search=a;b"},
	}
	for _, tc := range cases {
		t.Run(tc.route+"/"+tc.query, func(t *testing.T) {
			if _, err := parseFilter(tc.query, tc.route, testTraceID, time.Now()); err == nil {
				t.Fatal("invalid query accepted")
			}
		})
	}
	for _, id := range []string{"short", strings.Repeat("0", 32), strings.Repeat("z", 32)} {
		if _, err := parseFilter("", "detail", id, time.Now()); err == nil {
			t.Errorf("invalid detail identity %q accepted", id)
		}
	}
}

func TestQueryDefaultsAndExactBounds(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC)
	f, err := parseFilter("", "traces", "", now)
	if err != nil || !f.To.Equal(now) || !f.From.Equal(now.Add(-time.Hour)) || f.Limit != 50 {
		t.Fatalf("defaults = %+v, %v", f, err)
	}
	query := url.Values{
		"from": {now.Format(time.RFC3339Nano)}, "to": {now.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		"service": {strings.Repeat("a", 200)}, "search": {"%_test"}, "limit": {"100"}, "errorsOnly": {"true"},
	}
	f, err = parseFilter(query.Encode(), "traces", "", now)
	if err != nil || !f.From.Equal(now) || !f.To.Equal(now.Add(24*time.Hour)) || !f.ErrorsOnly || f.Limit != 100 || f.Search != "%_test" || len(f.Service) != 200 {
		t.Fatalf("explicit filters = %+v, %v", f, err)
	}
	for _, severity := range []string{"0", "24"} {
		f, err = parseFilter("minSeverity="+severity+"&traceId="+strings.ToUpper(testTraceID), "logs", "", now)
		if err != nil || f.TraceID != testTraceID {
			t.Fatalf("log filters = %+v, %v", f, err)
		}
	}
}

func TestReadRoutesEmptyArrays(t *testing.T) {
	cases := map[string]string{
		"/api/traces":                `{"items":[],"hasMore":false}`,
		"/api/logs":                  `{"items":[],"hasMore":false}`,
		"/api/traces/" + testTraceID: `{"traceId":"` + testTraceID + `","spans":[],"logs":[],"spansTruncated":false,"logsTruncated":false}`,
	}
	for path, want := range cases {
		t.Run(path, func(t *testing.T) {
			response := httptest.NewRecorder()
			NewServer(fakeReader{}).Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d", response.Code)
			}
			assertJSON(t, response, want)
		})
	}
}

func TestReadRoutesRejectInvalidQueryBeforeStorage(t *testing.T) {
	reader := fakeReader{traces: func(context.Context, telemetry.Filter) (telemetry.TraceList, error) {
		t.Fatal("invalid query reached storage")
		return telemetry.TraceList{}, nil
	}}
	response := httptest.NewRecorder()
	newHandler(reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/traces?project=other", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", response.Code)
	}
	assertJSON(t, response, `{"error":{"code":"invalid_query","message":"unknown query parameter"}}`)
}

func TestReadRoutesMethods(t *testing.T) {
	for _, path := range []string{"/api/traces", "/api/logs", "/api/traces/" + testTraceID} {
		for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
			t.Run(method+path, func(t *testing.T) {
				response := httptest.NewRecorder()
				newHandler(fakeReader{}).ServeHTTP(response, httptest.NewRequest(method, path, nil))
				if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
					t.Fatalf("wrong method response: %+v", response)
				}
				assertJSON(t, response, `{"error":{"code":"method_not_allowed","message":"method not allowed"}}`)
			})
		}
	}
}

func TestReadRoutesGenericFailure(t *testing.T) {
	secretError := errors.New("password=secret ClickHouse internal.host query failed")
	reader := fakeReader{
		traces: func(context.Context, telemetry.Filter) (telemetry.TraceList, error) {
			return telemetry.TraceList{}, secretError
		},
		logs: func(context.Context, telemetry.Filter) (telemetry.LogList, error) {
			return telemetry.LogList{}, secretError
		},
		trace: func(context.Context, string, telemetry.Filter) (telemetry.TraceDetail, error) {
			return telemetry.TraceDetail{}, secretError
		},
	}
	for _, handler := range []http.Handler{newHandler(reader), newHandler()} {
		for _, path := range []string{"/api/traces", "/api/logs", "/api/traces/" + testTraceID} {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("%s status = %d", path, response.Code)
			}
			assertJSON(t, response, `{"error":{"code":"unavailable","message":"telemetry storage unavailable"}}`)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
		assertJSON(t, response, `{"status":"ok"}`)
	}
}

func TestTraceNotFound(t *testing.T) {
	reader := fakeReader{trace: func(context.Context, string, telemetry.Filter) (telemetry.TraceDetail, error) {
		return telemetry.TraceDetail{}, telemetry.ErrNotFound
	}}
	response := httptest.NewRecorder()
	newHandler(reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/traces/"+testTraceID, nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	assertJSON(t, response, `{"error":{"code":"not_found","message":"trace not found"}}`)
}

func TestReadDeadlineAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := fakeReader{traces: func(queryCtx context.Context, _ telemetry.Filter) (telemetry.TraceList, error) {
		deadline, ok := queryCtx.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
			t.Fatalf("missing bounded deadline: %v, %v", deadline, ok)
		}
		cancel()
		<-queryCtx.Done()
		return telemetry.TraceList{}, queryCtx.Err()
	}}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/traces", nil).WithContext(ctx)
	newHandler(reader).ServeHTTP(response, request)
	if response.Body.Len() != 0 || len(response.Header()) != 0 {
		t.Fatalf("canceled request wrote a response: %+v", response)
	}
	reader.traces = func(context.Context, telemetry.Filter) (telemetry.TraceList, error) {
		return telemetry.TraceList{}, context.DeadlineExceeded
	}
	response = httptest.NewRecorder()
	newHandler(reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/traces", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("deadline failure status = %d", response.Code)
	}
}

func TestReadJSONDataContract(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC)
	reader := fakeReader{traces: func(context.Context, telemetry.Filter) (telemetry.TraceList, error) {
		return telemetry.TraceList{Items: []telemetry.TraceSummary{{TraceID: testTraceID, Name: "root", ServiceName: "api", StartTime: start, EndTime: start.Add(time.Second), DurationNs: "1000000000", SpanCount: 2, ErrorCount: 1}}, HasMore: true}, nil
	}}
	response := httptest.NewRecorder()
	newHandler(reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/traces", nil))
	assertJSON(t, response, `{"items":[{"traceId":"`+testTraceID+`","name":"root","serviceName":"api","startTime":"2026-01-01T00:00:00.123456789Z","endTime":"2026-01-01T00:00:01.123456789Z","durationNs":"1000000000","spanCount":2,"errorCount":1}],"hasMore":true}`)

	reader.trace = func(_ context.Context, id string, f telemetry.Filter) (telemetry.TraceDetail, error) {
		if id != testTraceID || f.TraceID != id {
			t.Fatalf("detail identity = %q, filter %+v", id, f)
		}
		return telemetry.TraceDetail{TraceID: id,
			Spans: []telemetry.Span{{TraceID: id, SpanID: "0123456789abcdef", ParentSpanID: "", Name: "root", ServiceName: "api", StartTime: start, DurationNs: "18446744073709551615", StatusCode: "Error", StatusMessage: "failed", ResourceAttributes: map[string]string{"logice.project.id": "validation"}, Attributes: map[string]string{"key": "value"}}},
			Logs:  []telemetry.Log{{Timestamp: start, TraceID: id, SpanID: "0123456789abcdef", ServiceName: "api", SeverityText: "ERROR", SeverityNumber: 17, Body: "full body", ResourceAttributes: map[string]string{}, Attributes: map[string]string{}}}, SpansTruncated: true, LogsTruncated: true}, nil
	}
	response = httptest.NewRecorder()
	newHandler(reader).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/traces/"+strings.ToUpper(testTraceID), nil))
	var detail telemetry.TraceDetail
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(detail.Spans) != 1 || len(detail.Logs) != 1 || detail.Spans[0].DurationNs != "18446744073709551615" || !detail.Spans[0].StartTime.Equal(start) || detail.Logs[0].Body != "full body" || detail.Logs[0].SeverityNumber != 17 || detail.Spans[0].Attributes["key"] != "value" || !detail.SpansTruncated || !detail.LogsTruncated {
		t.Fatalf("detail contract: %s", response.Body.String())
	}
}
