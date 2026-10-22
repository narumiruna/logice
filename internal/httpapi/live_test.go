package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

type liveFakeReader struct {
	fakeReader
	live func(context.Context, telemetry.LiveFilter) (telemetry.LiveSnapshot, error)
}

func (f liveFakeReader) Live(ctx context.Context, filter telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
	return f.live(ctx, filter)
}

func TestLiveValidation(t *testing.T) {
	now := time.Date(2026, 10, 23, 0, 0, 0, 123456789, time.UTC)
	for _, raw := range []string{"", "range=1m", "range=5m", "range=15m", "errorsOnly=true&minSeverity=24&search=%25_", "from=2026-10-23T00:00:00.123456789Z&to=2026-10-23T00:00:01.123456789Z"} {
		if _, err := parseLiveFilter(raw, now); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
	for _, raw := range []string{"range=", "range=2m", "range=5m&from=x&to=y", "from=x", "to=y", "from=x&to=y", "from=2026-10-23T00:00:00Z&to=2026-10-23T00:00:00.999999999Z", "from=2026-10-23T00:00:00Z&to=2026-10-23T00:15:00.000000001Z", "from=9999-10-23T00:00:00Z&to=9999-10-23T00:01:00Z", "from=2026-10-23T00:00:00.1234567891Z&to=2026-10-23T00:01:00Z", "from=2026-10-23T00:00:00%2B24:00&to=2026-10-23T00:01:00%2B24:00", "from=2026-10-23T00:00:00%2B00:60&to=2026-10-23T00:01:00%2B00:60", "project=foreign", "sql=SELECT", "limit=1", "cursor=x", "mode=live", "search=a&search=b", "range=1m&range=1m", "search=%zz", "search=%ff", "search=a;b", "errorsOnly=1", "errorsOnly=", "minSeverity=25", "minSeverity=-1", "minSeverity=", "service=" + strings.Repeat("a", 201), "search=" + url.QueryEscape(strings.Repeat("é", 101))} {
		if _, err := parseLiveFilter(raw, now); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestLiveHandler(t *testing.T) {
	var calls atomic.Int32
	reader := liveFakeReader{live: func(ctx context.Context, f telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
		calls.Add(1)
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 5*time.Second {
			t.Error("missing budget")
		}
		return telemetry.NewLiveSnapshot(f, time.Now()), nil
	}}
	h := newHandler(reader)
	for _, tc := range []struct {
		method, path string
		status       int
	}{{"GET", "/api/live", 200}, {"HEAD", "/api/live", 405}, {"POST", "/api/live", 405}, {"GET", "/api/live?project=other", 400}, {"GET", "/api/live?search=%zz", 400}, {"GET", "/api/live/not-found", 404}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d", tc.method, tc.path, w.Code)
		}
		if tc.path == "/api/live" || strings.Contains(tc.path, "?") {
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Error("missing no-store")
			}
		}
		if !json.Valid(w.Body.Bytes()) {
			t.Fatal("non-JSON")
		}
		if tc.status == 200 {
			var result telemetry.LiveSnapshot
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Histogram) != 60 || result.Spans == nil || result.Logs == nil || result.Context == nil {
				t.Fatal("invalid snapshot")
			}
		}
	}
	if calls.Load() != 1 {
		t.Fatal("invalid requests called store")
	}
	w := httptest.NewRecorder()
	newHandler().ServeHTTP(w, httptest.NewRequest("GET", "/api/live", nil))
	if w.Code != 503 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("no reader")
	}
}

func TestLiveErrorsAndSize(t *testing.T) {
	for _, tc := range []struct {
		name    string
		body    string
		failure error
		status  int
	}{{"failure", "", errors.New("SELECT secret-password query-plan"), 503}, {"too large", strings.Repeat("<", 1<<20), nil, 422}} {
		t.Run(tc.name, func(t *testing.T) {
			reader := liveFakeReader{live: func(ctx context.Context, f telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
				r := telemetry.NewLiveSnapshot(f, time.Now())
				r.Logs = []telemetry.LiveRecord{{Body: tc.body}}
				return r, tc.failure
			}}
			h := newHandler(reader)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/api/live", nil))
			if w.Code != tc.status || strings.Contains(w.Body.String(), "secret-password") || !json.Valid(w.Body.Bytes()) || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("bad error %d %s", w.Code, w.Body.String())
			}
			health := httptest.NewRecorder()
			h.ServeHTTP(health, httptest.NewRequest("GET", "/api/healthz", nil))
			if health.Code != 200 {
				t.Fatal("liveness depends on storage")
			}
		})
	}
}

func TestLiveAdmissionCancellation(t *testing.T) {
	entered := make(chan struct{}, 3)
	reader := liveFakeReader{live: func(ctx context.Context, f telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return telemetry.LiveSnapshot{}, ctx.Err()
	}}
	h := newHandler(reader)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/api/live", nil).WithContext(ctx))
			done <- struct{}{}
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("request did not enter")
		}
	}
	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest("GET", "/api/healthz", nil))
	if health.Code != 200 {
		t.Fatal("admission blocked liveness")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/live", nil))
	if w.Code != 429 || w.Header().Get("Retry-After") != "2" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("admission did not reject")
	}
	cancel()
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("cancellation did not release")
		}
	}
	ctx2, stop := context.WithCancel(context.Background())
	defer stop()
	next := make(chan struct{})
	go func() {
		defer close(next)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/live", nil).WithContext(ctx2))
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("admission slot leaked")
	}
	stop()
	<-next
}

func TestLiveExpiredBudgetNeverSuccess(t *testing.T) {
	reader := liveFakeReader{live: func(ctx context.Context, f telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
		return telemetry.NewLiveSnapshot(f, time.Now()), nil
	}}
	h := newLiveHandler(reader)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/live", nil).WithContext(ctx))
	if w.Body.Len() != 0 {
		t.Fatal("canceled request wrote body")
	}
}
