//go:build integration

package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestIngestionLimitsAndUpstreamFailures(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	user, project, raw := uuid.NewString(), uuid.NewString(), token()
	for _, statement := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO auth_users(id,name,active) VALUES($1,'Proxy',true)", []any{user}}, {"INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Proxy',$2)", []any{project, user}}, {"INSERT INTO project_tokens(id,project_id,name,token_hash,creator_user_id) VALUES($1,$2,'Proxy',$3,$4)", []any{uuid.NewString(), project, digest(raw), user}}} {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	var mode atomic.Int32
	entered := make(chan struct{}, 128)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	redirected := atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect-target" {
			redirected.Add(1)
			return
		}
		switch mode.Load() {
		case 1:
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			_, _ = w.Write([]byte("partial-success"))
		case 2:
			_, _ = w.Write([]byte(strings.Repeat("x", (1<<20)+1)))
		case 3:
			w.Header().Set("Location", "/redirect-target")
			w.WriteHeader(307)
		case 4:
			select {
			case <-r.Context().Done():
			case <-time.After(12 * time.Second):
			}
		case 5:
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
			}
		default:
			w.WriteHeader(200)
		}
	}))
	defer upstream.Close()
	if err := s.ConfigureIngestion(upstream.URL, "internal-credential"); err != nil {
		t.Fatal(err)
	}
	call := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/traces", strings.NewReader("fixture")).WithContext(ctx)
		r.Header.Set("Authorization", "Bearer "+raw)
		r.Header.Set("Content-Type", "application/x-protobuf")
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	mode.Store(1)
	w := call()
	if w.Code != 429 || w.Body.String() != "partial-success" || w.Header().Get("Retry-After") != "7" {
		t.Fatal("upstream response changed")
	}
	mode.Store(2)
	if w = call(); w.Code != 502 {
		t.Fatal("unbounded upstream response", w.Code)
	}
	mode.Store(3)
	if w = call(); w.Code != 307 || redirected.Load() != 0 {
		t.Fatal("followed upstream redirect")
	}
	mode.Store(4)
	start := time.Now()
	if w = call(); w.Code != 502 || time.Since(start) > 11*time.Second {
		t.Fatal("upstream deadline", w.Code)
	}
	mode.Store(5)
	var wg sync.WaitGroup
	for range 128 {
		wg.Go(func() { _ = call() })
	}
	deadline := time.After(8 * time.Second)
	for range 128 {
		select {
		case <-entered:
		case <-deadline:
			unblock()
			wg.Wait()
			t.Fatal("128 concurrent requests did not reach upstream")
		}
	}
	if w = call(); w.Code != 429 {
		unblock()
		wg.Wait()
		t.Fatal("concurrent ingestion limit", w.Code)
	}
	unblock()
	wg.Wait()
	upstream.Close()
	mode.Store(0)
	if w = call(); w.Code != 502 {
		t.Fatal("closed upstream accepted", w.Code)
	}
}

func TestIngestionConfigurationRejectsUntrustedEndpoints(t *testing.T) {
	s := testService(t, "https://example.test")
	for _, endpoint := range []string{"", "file:///etc/passwd", "http://user:pass@collector:4318", "http://collector:4318/v1/traces", "http://collector:4318?query=x", "http://collector:4318#fragment"} {
		if s.ConfigureIngestion(endpoint, "internal") == nil {
			t.Fatal("invalid endpoint accepted")
		}
	}
	if s.ConfigureIngestion("http://collector:4318", "") == nil {
		t.Fatal("empty infrastructure credential accepted")
	}
}
