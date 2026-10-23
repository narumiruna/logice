//go:build integration

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This fixture starts only a disposable local container. It never reads DATABASE_URL.
func disposablePostgres(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	docker := func(args ...string) string {
		t.Helper()
		commandCtx, stop := context.WithTimeout(context.Background(), 45*time.Second)
		defer stop()
		output, err := exec.CommandContext(commandCtx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, output)
		}
		return strings.TrimSpace(string(output))
	}
	id := docker("run", "--detach", "--rm", "-e", "POSTGRES_PASSWORD=fake-auth-test-password", "-e", "POSTGRES_DB=auth_test", "-p", "127.0.0.1::5432", "postgres:18.6-alpine3.23@sha256:885cf05d376c7cf27afef02073e6bdac3841252537f16e244fd1c1e6a7c99fb1")
	t.Cleanup(func() { docker("rm", "--force", id) })
	address := docker("port", id, "5432/tcp")
	host, port, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		t.Fatalf("unsafe test database address %q: %v", address, err)
	}
	dsn := fmt.Sprintf("postgres://postgres:fake-auth-test-password@127.0.0.1:%s/auth_test?sslmode=disable", port)
	var pool *pgxpool.Pool
	for {
		pool, err = Open(ctx, dsn)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("database startup: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Cleanup(pool.Close)
	return pool, ctx
}

func TestStoreIntegration(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	execSQL := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	count := func(table string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	reset := func() {
		execSQL("TRUNCATE auth_ceremonies,auth_sessions,auth_invitations,auth_credentials,auth_users CASCADE")
	}
	user := func(admin bool) string {
		t.Helper()
		id := uuid.NewString()
		execSQL("INSERT INTO auth_users(id,name,active,admin) VALUES($1,'Test account',true,$2)", id, admin)
		return id
	}
	session := func(id, previous string) string {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollback(tx)
		raw, err := newSession(ctx, tx, id, previous)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return raw
	}
	service := testService(t, "https://example.test")
	service.pool = pool
	request := func(path, body, sessionRaw string) *http.Request {
		r := authRequest(service, "POST", path, body)
		r = r.WithContext(ctx)
		if sessionRaw != "" {
			r.AddCookie(&http.Cookie{Name: service.cookieName("session"), Value: sessionRaw})
		}
		return r
	}
	call := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		service.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}

	t.Run("migration serializes and repeats", func(t *testing.T) {
		if Ready(ctx, pool) == nil {
			t.Fatal("unmigrated database ready")
		}
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for range 8 {
			wg.Go(func() { errs <- Migrate(ctx, pool) })
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if err := Ready(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if count("auth_schema_versions") != 1 {
			t.Fatal("duplicate schema version")
		}
		// Retrying initialization upgrades an earlier sessions table in place.
		execSQL("ALTER TABLE auth_sessions DROP COLUMN browser_hash")
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "SELECT browser_hash FROM auth_sessions"); err != nil {
			t.Fatal("missing browser binding after retry", err)
		}
	})
	t.Run("concurrent bootstrap", func(t *testing.T) {
		reset()
		var successes atomic.Int32
		var wg sync.WaitGroup
		for range 12 {
			wg.Go(func() {
				v, err := Bootstrap(ctx, pool, "Administrator")
				if err == nil {
					if !validToken(v.Token) {
						t.Error("invalid invitation")
					}
					successes.Add(1)
				}
			})
		}
		wg.Wait()
		if successes.Load() != 1 || count("auth_users") != 1 || count("auth_invitations") != 1 {
			t.Fatal("bootstrap was not atomic")
		}
		if count("auth_events") != 1 {
			t.Fatal("bootstrap audit event missing or duplicated")
		}
		if _, err := Bootstrap(ctx, pool, "Another administrator"); err == nil {
			t.Fatal("repeated bootstrap accepted")
		}
		var admin, active bool
		if err := pool.QueryRow(ctx, "SELECT admin,active FROM auth_users").Scan(&admin, &active); err != nil || !admin || active {
			t.Fatal("unsafe bootstrap state", err)
		}
	})
	t.Run("session expiry rotation revocation", func(t *testing.T) {
		reset()
		id := user(false)
		old := session(id, "")
		fresh := session(id, old)
		if _, err := sessionUser(ctx, pool, old); !errors.Is(err, errDenied) {
			t.Fatal("old session accepted", err)
		}
		if _, err := sessionUser(ctx, pool, fresh); err != nil {
			t.Fatal(err)
		}
		for _, sql := range []string{"UPDATE auth_sessions SET last_seen=now()-interval '25 hours' WHERE token_hash=$1", "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1"} {
			raw := session(id, "")
			execSQL(sql, digest(raw))
			if _, err := sessionUser(ctx, pool, raw); !errors.Is(err, errDenied) {
				t.Fatal("expired session accepted", err)
			}
		}
		var expiry time.Time
		if err := pool.QueryRow(ctx, "SELECT expires_at FROM auth_sessions WHERE token_hash=$1", digest(fresh)).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		if _, err := sessionUser(ctx, pool, fresh); err != nil {
			t.Fatal(err)
		}
		var after time.Time
		_ = pool.QueryRow(ctx, "SELECT expires_at FROM auth_sessions WHERE token_hash=$1", digest(fresh)).Scan(&after)
		if !expiry.Equal(after) {
			t.Fatal("absolute expiry extended")
		}
		w := call(request("/api/auth/logout", "{}", fresh))
		if w.Code != 204 {
			t.Fatalf("logout %d", w.Code)
		}
		if _, err := sessionUser(ctx, pool, fresh); !errors.Is(err, errDenied) {
			t.Fatal("revoked session accepted", err)
		}
	})
	t.Run("administrator invitations and recovery", func(t *testing.T) {
		reset()
		admin := user(true)
		other := user(false)
		if w := call(request("/api/auth/invitations", `{"name":"Invited account"}`, session(other, ""))); w.Code != 403 {
			t.Fatalf("non-admin status %d", w.Code)
		}
		adminSession := session(admin, "")
		w := call(request("/api/auth/invitations", `{"name":"Invited account"}`, adminSession))
		if w.Code != 201 {
			t.Fatalf("admin status %d: %s", w.Code, w.Body.String())
		}
		var invitation Invitation
		if err := json.Unmarshal(w.Body.Bytes(), &invitation); err != nil || !validToken(invitation.Token) {
			t.Fatal("invalid invitation", err)
		}
		// Give the operator's target each existing login path before recovery.
		execSQL("INSERT INTO auth_credentials(id,user_id,data) VALUES($1,$2,'{}')", []byte("fake-credential"), admin)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		old, err := invite(ctx, tx, admin)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		replacement, err := Recover(ctx, pool, admin)
		if err != nil {
			t.Fatal(err)
		}
		var recoveryEvents int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE action='operator_recovery' AND user_id=$1", admin).Scan(&recoveryEvents); err != nil || recoveryEvents != 1 {
			t.Fatal("recovery audit event missing", err)
		}
		if replacement.Token == old.Token || !validToken(replacement.Token) {
			t.Fatal("invitation not rotated")
		}
		if _, err = sessionUser(ctx, pool, adminSession); !errors.Is(err, errDenied) {
			t.Fatal("recovered session accepted", err)
		}
		var active bool
		var generation int64
		if err = pool.QueryRow(ctx, "SELECT active,generation FROM auth_users WHERE id=$1", admin).Scan(&active, &generation); err != nil || active || generation != 1 {
			t.Fatal("recovery generation", err)
		}
		var n int
		if err = pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", admin).Scan(&n); err != nil || n != 0 {
			t.Fatal("credential not revoked", err)
		}
		if w := call(request("/api/auth/enroll/begin", fmt.Sprintf(`{"token":%q}`, old.Token), "")); w.Code != 401 {
			t.Fatal("old invite accepted")
		}
		execSQL("UPDATE auth_invitations SET expires_at=now()-interval '1 second' WHERE token_hash=$1", digest(replacement.Token))
		if w := call(request("/api/auth/enroll/begin", fmt.Sprintf(`{"token":%q}`, replacement.Token), "")); w.Code != 401 {
			t.Fatal("expired invite accepted")
		}
	})
	t.Run("ceremony binding expiry single use and invalid finish", func(t *testing.T) {
		reset()
		save := func(kind string) (*http.Request, string) {
			t.Helper()
			r := request("/api/auth/login/finish", "{}", "")
			version, err := browserVersion(ctx, pool, service.readCookie(r, "csrf"))
			if err != nil {
				t.Fatal(err)
			}
			r = r.WithContext(context.WithValue(ctx, browserVersionKey{}, version))
			w := httptest.NewRecorder()
			if err := service.saveCeremony(w, r, kind, ceremony{}); err != nil {
				t.Fatal(err)
			}
			c := w.Result().Cookies()[0]
			r.AddCookie(c)
			return r, c.Value
		}
		r, raw := save("login")
		wrong := r.Clone(ctx)
		wrong.Header = r.Header.Clone()
		wrong.Header.Del("Cookie")
		wrong.AddCookie(&http.Cookie{Name: service.cookieName("ceremony"), Value: raw})
		wrong.AddCookie(&http.Cookie{Name: service.cookieName("csrf"), Value: token()})
		if _, err := service.consume(httptest.NewRecorder(), wrong, "login"); !errors.Is(err, errDenied) {
			t.Fatal("wrong CSRF accepted", err)
		}
		if _, err := service.consume(httptest.NewRecorder(), r, "enroll"); !errors.Is(err, errDenied) {
			t.Fatal("wrong kind accepted", err)
		}
		var successes atomic.Int32
		var wg sync.WaitGroup
		for range 12 {
			wg.Go(func() {
				if _, err := service.consume(httptest.NewRecorder(), r, "login"); err == nil {
					successes.Add(1)
				}
			})
		}
		wg.Wait()
		if successes.Load() != 1 {
			t.Fatal("ceremony not single-use")
		}
		r, raw = save("login")
		execSQL("UPDATE auth_ceremonies SET expires_at=now()-interval '1 second' WHERE token_hash=$1", digest(raw))
		if _, err := service.consume(httptest.NewRecorder(), r, "login"); !errors.Is(err, errDenied) {
			t.Fatal("expired ceremony accepted", err)
		}
		r, raw = save("login")
		w := call(r)
		if w.Code != 401 {
			t.Fatalf("invalid finish status %d", w.Code)
		}
		if _, err := service.consume(httptest.NewRecorder(), r, "login"); !errors.Is(err, errDenied) {
			t.Fatal("invalid finish did not consume state", err)
		}
		if count("auth_sessions") != 0 {
			t.Fatal("invalid finish created session")
		}
		if err := Cleanup(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if count("auth_ceremonies") != 0 {
			t.Fatal("expired state not cleaned")
		}
	})
	t.Run("enrollment invalid finish consumes ceremony not invitation and recovery invalidates generation", func(t *testing.T) {
		reset()
		invitation, err := Bootstrap(ctx, pool, "Administrator")
		if err != nil {
			t.Fatal(err)
		}
		begin := func(raw string) *http.Request {
			t.Helper()
			r := request("/api/auth/enroll/begin", fmt.Sprintf(`{"token":%q}`, raw), "")
			w := call(r)
			if w.Code != 200 {
				t.Fatalf("enrollment begin: %d %s", w.Code, w.Body.String())
			}
			finish := r.Clone(ctx)
			finish.URL.Path = "/api/auth/enroll/finish"
			finish.Body = io.NopCloser(strings.NewReader("{}"))
			for _, cookie := range w.Result().Cookies() {
				if cookie.Name == service.cookieName("ceremony") {
					finish.AddCookie(cookie)
				}
			}
			return finish
		}
		r := begin(invitation.Token)
		if w := call(r); w.Code != 401 {
			t.Fatalf("invalid enrollment finish: %d", w.Code)
		}
		if count("auth_ceremonies") != 0 || count("auth_sessions") != 0 || count("auth_credentials") != 0 || count("auth_invitations") != 1 {
			t.Fatal("invalid finish changed login paths or retained ceremony")
		}
		// A failed authenticator response does not burn the operator invitation.
		r = begin(invitation.Token)
		var id string
		if err := pool.QueryRow(ctx, "SELECT id::text FROM auth_users").Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := Recover(ctx, pool, id); err != nil {
			t.Fatal(err)
		}
		if w := call(r); w.Code != 401 {
			t.Fatalf("pre-recovery ceremony accepted: %d", w.Code)
		}
		if count("auth_sessions") != 0 || count("auth_credentials") != 0 {
			t.Fatal("recovery ceremony established login")
		}
	})
	t.Run("database unavailable fails closed health independent", func(t *testing.T) {
		pool.Close()
		for _, path := range []string{"/api/query", "/api/auth/session"} {
			r := httptest.NewRequest("GET", path, nil)
			r.AddCookie(&http.Cookie{Name: service.cookieName("session"), Value: token()})
			if w := call(r); w.Code != 503 {
				t.Fatalf("database unavailable %s: %d", path, w.Code)
			}
		}
		w := httptest.NewRecorder()
		service.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, httptest.NewRequest("GET", "/api/healthz", nil))
		if w.Code != 204 {
			t.Fatal("health depends on database")
		}
	})
}
