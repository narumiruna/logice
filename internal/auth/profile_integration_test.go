//go:build integration

package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAccountProfileSettings(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	id, other, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
	session := token()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active,admin) VALUES($1,'Original',true,true),($2,'Other',true,false)", id, other)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), id)
	exec("INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Owned',$2)", project, id)
	exec("INSERT INTO auth_credentials(id,user_id,data) VALUES($1,$2,'{}')", []byte("profile-fixture"), id)
	call := func(body string, change func(*http.Request)) *httptest.ResponseRecorder {
		r := authRequest(s, "POST", "/api/auth/profile", body).WithContext(ctx)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
		if change != nil {
			change(r)
		}
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	for _, body := range []string{`{}`, `{"name":""}`, `{"name":" spaced "}`, `{"name":"line\nfeed"}`, `{"name":"` + strings.Repeat("x", 81) + `"}`, `{"name":"Updated","admin":false}`, `{"name":"Updated","userId":"` + other + `"}`, `{"name":"Updated"} {}`, `null`} {
		if w := call(body, nil); w.Code != 400 {
			t.Fatalf("invalid profile status %d", w.Code)
		}
	}
	for _, change := range []func(*http.Request){func(r *http.Request) { r.Header.Del("Origin") }, func(r *http.Request) { r.Header.Set("X-CSRF-Token", token()) }} {
		if w := call(`{"name":"Updated"}`, change); w.Code != 403 {
			t.Fatal("missing CSRF/origin accepted", w.Code)
		}
	}
	if w := call(`{"name":"Updated"}`, func(r *http.Request) {
		cookies := r.Cookies()
		r.Header.Del("Cookie")
		for _, cookie := range cookies {
			if cookie.Name != s.cookieName("session") {
				r.AddCookie(cookie)
			}
		}
	}); w.Code != 401 {
		t.Fatal("anonymous profile accepted", w.Code)
	}
	w := call(`{"name":"New display name"}`, nil)
	var result struct {
		User User `json:"user"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.User.ID != id || !result.User.Admin || result.User.Name != "New display name" {
		t.Fatal("invalid profile result", w.Code)
	}
	var name, owner string
	var credentials, audits int
	if err := pool.QueryRow(ctx, "SELECT name FROM auth_users WHERE id=$1", other).Scan(&name); err != nil || name != "Other" {
		t.Fatal("another account changed", err)
	}
	if err := pool.QueryRow(ctx, "SELECT owner_user_id::text FROM projects WHERE id=$1", project).Scan(&owner); err != nil || owner != id {
		t.Fatal("ownership changed", err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", id).Scan(&credentials); err != nil || credentials != 1 {
		t.Fatal("credentials changed", err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE user_id=$1 AND action='profile_updated'", id).Scan(&audits); err != nil || audits != 1 {
		t.Fatal("audit mismatch", err)
	}
	user, err := sessionUser(ctx, pool, session)
	if err != nil || user.Name != "New display name" {
		t.Fatal("profile did not persist in session", err)
	}
	session = token()
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), other)
	w = call(`{"name":"Regular account"}`, nil)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.User.ID != other || result.User.Admin || result.User.Name != "Regular account" {
		t.Fatal("regular account cannot update its own profile", w.Code)
	}
	exec("UPDATE auth_users SET active=false WHERE id=$1", other)
	if w := call(`{"name":"Inactive account"}`, nil); w.Code != 401 {
		t.Fatal("inactive account updated its profile", w.Code)
	}
	pool.Close()
	if w := call(`{"name":"No storage"}`, nil); w.Code != 503 {
		t.Fatal("storage failure not closed", w.Code)
	}
}
