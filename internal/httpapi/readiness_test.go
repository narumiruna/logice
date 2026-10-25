package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadinessStatusMethodsAndExactPath(t *testing.T) {
	for _, ready := range []bool{true, false} {
		for _, method := range []string{"GET", "HEAD"} {
			var calls int
			handler := WithReadiness(http.NotFoundHandler(), func(ctx context.Context) error {
				calls++
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 2*time.Second {
					t.Fatal("probe has no bounded deadline")
				}
				if !ready {
					return errors.New("private database credential detail")
				}
				return nil
			})
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(method, "/api/readyz?probe=1", nil))
			want := http.StatusServiceUnavailable
			if ready {
				want = http.StatusOK
			}
			if w.Code != want || calls != 1 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d calls=%d headers=%v", w.Code, calls, w.Header())
			}
			if method == "HEAD" && w.Body.Len() != 0 || strings.Contains(w.Body.String(), "private") {
				t.Fatal("probe exposed a body or error")
			}
		}
	}
	calls := 0
	handler := WithReadiness(newHandler(), func(context.Context) error { calls++; return nil })
	for _, method := range []string{"POST", "PUT", "DELETE", "PATCH", "OPTIONS"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(method, "/api/readyz", nil))
		if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" || calls != 0 {
			t.Fatal("wrong-method probe reached dependencies")
		}
	}
	for _, path := range []string{"/api/readyz/", "/api/readyz/other", "/api/healthz"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		want := 404
		if path == "/api/healthz" {
			want = 200
		}
		if w.Code != want || calls != 0 {
			t.Fatal("probe intercepted another route")
		}
	}
}

func TestReadinessTimeoutCancellationAndAdmission(t *testing.T) {
	var calls atomic.Int32
	entered := make(chan struct{})
	handler := withReadiness(newHandler(), func(ctx context.Context) error {
		calls.Add(1)
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(first, httptest.NewRequest("GET", "/api/readyz", nil).WithContext(ctx))
	}()
	<-entered
	for _, path := range []string{"/api/readyz", "/api/healthz"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		want := 503
		if path == "/api/healthz" {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("%s status=%d", path, w.Code)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("probe did not honor its deadline")
	}
	if first.Code != 503 || calls.Load() != 1 {
		t.Fatal("timeout or admission failed")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/readyz", nil).WithContext(ctx))
	if w.Code != 503 || calls.Load() != 1 {
		t.Fatal("cancelled request queried storage")
	}
	w = httptest.NewRecorder()
	timeoutHandler := withReadiness(newHandler(), func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}, 10*time.Millisecond)
	start := time.Now()
	timeoutHandler.ServeHTTP(w, httptest.NewRequest("GET", "/api/readyz", nil))
	if w.Code != 503 || time.Since(start) > time.Second {
		t.Fatal("probe timeout failed")
	}
	w = httptest.NewRecorder()
	WithReadiness(newHandler(), nil).ServeHTTP(w, httptest.NewRequest("GET", "/api/readyz", nil))
	if w.Code != 503 {
		t.Fatal("unconfigured readiness passed")
	}
}
