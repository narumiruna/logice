//go:build integration

package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestLogoutCeremonyAndSessionOrdering(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	r := authRequest(s, "POST", "/api/auth/login/begin", "{}")
	csrf := s.readCookie(r, "csrf")
	version, err := browserVersion(ctx, pool, csrf)
	if err != nil {
		t.Fatal(err)
	}
	r = r.WithContext(context.WithValue(ctx, browserVersionKey{}, version))
	user := &User{ID: uuid.NewString(), Name: "Ordering test"}
	if _, err = pool.Exec(ctx, "INSERT INTO auth_users(id,name,active) VALUES($1,$2,true)", user.ID, user.Name); err != nil {
		t.Fatal(err)
	}
	if err = s.saveCeremony(httptest.NewRecorder(), r, "login", ceremony{}); err != nil {
		t.Fatal(err)
	}
	if err = logout(ctx, pool, csrf, ""); err != nil {
		t.Fatal(err)
	}
	var ceremonies int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM auth_ceremonies").Scan(&ceremonies); err != nil || ceremonies != 0 {
		t.Fatalf("logout retained challenges: %d %v", ceremonies, err)
	}
	if err = s.saveCeremony(httptest.NewRecorder(), r, "login", ceremony{}); !errors.Is(err, errDenied) {
		t.Fatalf("delayed begin survived logout: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.complete(w, r, tx, user, version)
	rollback(tx)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("old finish survived logout: %d", w.Code)
	}

	// A finish owns the browser lock first. Logout must wait, then revoke its new session.
	version, err = browserVersion(ctx, pool, csrf)
	if err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(tx)
	var locked int64
	if err = tx.QueryRow(ctx, "SELECT generation FROM auth_browsers WHERE token_hash=$1 FOR UPDATE", digest(csrf)).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- logout(ctx, pool, csrf, "") }()
	// Observe the actual database lock wait, not goroutine scheduling or elapsed time.
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		var waiting bool
		err = pool.QueryRow(waitCtx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
		 WHERE wait_event_type='Lock' AND query LIKE 'UPDATE auth_browsers SET generation=generation+1%')`).Scan(&waiting)
		if err != nil {
			t.Fatalf("observe logout lock wait: %v", err)
		}
		if waiting {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("logout did not serialize with issue: %v", err)
		case <-waitCtx.Done():
			t.Fatal("logout did not reach the browser lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	r = r.WithContext(context.WithValue(ctx, browserVersionKey{}, version))
	w = httptest.NewRecorder()
	s.complete(w, r, tx, user, version)
	if w.Code != 200 {
		t.Fatalf("session issue failed: %d %s", w.Code, w.Body.String())
	}
	if err = <-finished; err != nil {
		t.Fatal(err)
	}
	var sessions int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM auth_sessions").Scan(&sessions); err != nil || sessions != 0 {
		t.Fatalf("concurrent finish survived logout: %d %v", sessions, err)
	}
	// Repeated logout remains idempotent, including when auth limits are exhausted.
	for range 30 {
		s.limits.allow(csrf, time.Now())
	}
	request := authRequest(s, "POST", "/api/auth/logout", "{}")
	request.Header.Del("Cookie")
	request.AddCookie(&http.Cookie{Name: s.cookieName("csrf"), Value: csrf})
	request.Header.Set("X-CSRF-Token", csrf)
	w = httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, request)
	if w.Code != 204 {
		t.Fatalf("logout rate limited: %d %s", w.Code, w.Body.String())
	}
}
