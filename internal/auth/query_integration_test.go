//go:build integration

package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/logice/internal/httpapi"
	"github.com/narumiruna/logice/internal/telemetry"
)

type waitingReader struct{ wait func(context.Context) error }

func (r waitingReader) Traces(ctx context.Context, _ telemetry.Filter) (telemetry.TraceList, error) {
	return telemetry.TraceList{}, r.wait(ctx)
}
func (r waitingReader) Logs(ctx context.Context, _ telemetry.Filter) (telemetry.LogList, error) {
	return telemetry.LogList{}, r.wait(ctx)
}
func (r waitingReader) Trace(ctx context.Context, _ string, _ telemetry.Filter) (telemetry.TraceDetail, error) {
	return telemetry.TraceDetail{}, r.wait(ctx)
}
func (r waitingReader) Live(ctx context.Context, _ telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
	return telemetry.LiveSnapshot{}, r.wait(ctx)
}

func TestAuthenticatedQueryContexts(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	userID := uuid.NewString()
	if _, err := pool.Exec(ctx, "INSERT INTO auth_users(id,name,active) VALUES($1,'Query test',true)", userID); err != nil {
		t.Fatal(err)
	}
	session := token()
	if _, err := pool.Exec(ctx, "INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), userID); err != nil {
		t.Fatal(err)
	}
	project := uuid.NewString()
	if _, err := pool.Exec(ctx, "INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Query project',$2)", project, userID); err != nil {
		t.Fatal(err)
	}
	request := func(parent context.Context, path string) *http.Request {
		path = strings.Replace(path, "/api/", "/api/projects/"+project+"/", 1)
		r := httptest.NewRequest("GET", path, nil).WithContext(parent)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
		return r
	}
	t.Run("slow queries retain structured errors", func(t *testing.T) {
		for _, path := range []string{"/api/traces", "/api/logs", "/api/traces/0123456789abcdef0123456789abcdef", "/api/live"} {
			t.Run(path, func(t *testing.T) {
				t.Parallel()
				parent, cancel := context.WithTimeout(ctx, 20*time.Second)
				defer cancel()
				reader := waitingReader{wait: func(query context.Context) error { <-query.Done(); return query.Err() }}
				handler := httpapi.NewServer(reader).Handler
				next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Context().Done() != parent.Done() {
						t.Error("authentication replaced the original query request context")
					}
					handler.ServeHTTP(w, r)
				})
				w := httptest.NewRecorder()
				s.Wrap(next).ServeHTTP(w, request(parent, path))
				var body struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != "unavailable" {
					t.Errorf("query timeout returned status %d and body %q; want structured 503", w.Code, w.Body.String())
				}
				if parent.Err() != nil {
					t.Errorf("authentication canceled the original request: %v", parent.Err())
				}
			})
		}
	})
	t.Run("client cancellation reaches the query", func(t *testing.T) {
		parent, cancel := context.WithCancel(ctx)
		defer cancel()
		entered := make(chan struct{})
		done := make(chan struct{})
		reader := waitingReader{wait: func(query context.Context) error { close(entered); <-query.Done(); return query.Err() }}
		w := httptest.NewRecorder()
		go func() {
			defer close(done)
			s.Wrap(httpapi.NewServer(reader).Handler).ServeHTTP(w, request(parent, "/api/live"))
		}()
		select {
		case <-entered:
		case <-time.After(10 * time.Second):
			t.Fatal("query did not start")
		}
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("client cancellation did not stop the query")
		}
		if w.Body.Len() != 0 {
			t.Errorf("disconnected request received a response: %q", w.Body.String())
		}
	})
	t.Run("session lookup keeps its own deadline", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollback(tx)
		var hash []byte
		if err = tx.QueryRow(ctx, "SELECT token_hash FROM auth_sessions WHERE token_hash=$1 FOR UPDATE", digest(session)).Scan(&hash); err != nil {
			t.Fatal(err)
		}
		parent, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		called := false
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) })
		w := httptest.NewRecorder()
		s.Wrap(next).ServeHTTP(w, request(parent, "/api/traces"))
		if called || w.Code != 503 {
			t.Errorf("blocked session lookup reached the query or returned status %d", w.Code)
		}
		if parent.Err() != nil {
			t.Errorf("session lookup exhausted the client deadline: %v", parent.Err())
		}
	})
}
